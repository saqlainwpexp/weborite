import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { API_PORT, addEvent } from "../db.ts";
import { ClaudeUnavailableError } from "../claude/runner.ts";
import { siteDir } from "../builds/store.ts";
import type { WpConversion, WpPage } from "../../shared/types.ts";
import { digestPage, type SectionDigest } from "./digest.ts";
import { convertSection } from "./convert.ts";
import type { ElementorElement } from "./validate.ts";
import { buildPluginZip } from "./plugin.ts";
import { WpError, ping, upsertPage, uploadMedia, type WpAuth } from "./client.ts";
import { comparePages } from "./compare.ts";
import { convDir, getConversion, getSecrets, listConversions, saveConversion } from "./store.ts";

const fileFor = (slug: string) => (slug === "index" ? "index.html" : `${slug}.html`);
const pageDir = (c: WpConversion, slug: string) => join(convDir(c.id), "pages", slug);
const widgetDir = (c: WpConversion) => join(convDir(c.id), "widgets");
export const pluginPath = (c: WpConversion) => join(convDir(c.id), `studio-connector-1.0.${c.pluginVersion}.zip`);

/** Paused until the user installs the updated plugin, fixes credentials, or Claude comes back. */
export class NeedsUserError extends Error {}

function auth(c: WpConversion): WpAuth {
  return { siteUrl: c.siteUrl, user: c.wpUser, appPassword: getSecrets(c.id).secret };
}

export async function rebuildPlugin(c: WpConversion) {
  mkdirSync(widgetDir(c), { recursive: true });
  const widgets = c.customWidgets.map((w) => ({ ...w, php: readFileSync(join(widgetDir(c), `${w.name}.php`), "utf8") }));
  await buildPluginZip(pluginPath(c), { version: c.pluginVersion, previewToken: getSecrets(c.id).previewToken, widgets });
}

export async function checkConnection(c: WpConversion) {
  try {
    const p = await ping(auth(c));
    c.connected = { ok: true, elementor: p.elementor, pro: p.pro, plugin: p.plugin, checkedAt: new Date().toISOString() };
    const missing = c.customWidgets.filter((w) => !p.widgets.includes(w.name));
    if (missing.length) throw new NeedsUserError(`Update the Studio Connector plugin to 1.0.${c.pluginVersion}. It adds ${missing.map((w) => w.title).join(", ")}.`);
    if (c.elementorPro && !p.pro) throw new NeedsUserError("This conversion uses Elementor Pro, but Pro isn't active on the site.");
    if (!p.elementor) throw new NeedsUserError("Elementor isn't active on the site.");
  } catch (e) {
    if (!(e instanceof NeedsUserError)) c.connected = { ok: false, elementor: "", pro: false, plugin: "", checkedAt: new Date().toISOString() };
    saveConversion(c);
    if (e instanceof WpError || e instanceof NeedsUserError) throw new NeedsUserError(e.message);
    throw e;
  }
  saveConversion(c);
}

/** Upload every asset the built site uses, once. Returns local path → WordPress media. */
async function ensureMedia(c: WpConversion) {
  const mapPath = join(convDir(c.id), "media.json");
  const map: Record<string, { url: string; id: number | "" }> = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, "utf8")) : {};
  const assets = join(siteDir(c.buildId), "assets");
  if (!existsSync(assets)) return map;
  for (const f of readdirSync(assets)) {
    const key = `assets/${f}`;
    if (map[key]) continue;
    map[key] = await uploadMedia(auth(c), join(assets, f));
    writeFileSync(mapPath, JSON.stringify(map, null, 1));
  }
  return map;
}

function sectionLabel(s: SectionDigest) {
  return s.tag === "header" ? "Header" : s.tag === "footer" ? "Footer" : s.label.replace(/[-_]/g, " ");
}

async function convertAndStore(c: WpConversion, page: WpPage, s: SectionDigest, ctx: { fonts: string[]; media: Record<string, { url: string; id: number | "" }> }, feedback?: string) {
  const sec = page.sections.find((x) => x.index === s.index)!;
  sec.status = "converting";
  saveConversion(c);
  const out = await convertSection({
    leadId: c.buildId, cwd: convDir(c.id), section: s, fonts: ctx.fonts, pro: c.elementorPro, media: ctx.media,
    existingCustomWidgets: c.customWidgets.map((w) => ({ name: w.name, replaces: w.replaces })),
    feedback,
  });
  for (const w of out.customWidgets) {
    mkdirSync(widgetDir(c), { recursive: true });
    writeFileSync(join(widgetDir(c), `${w.name}.php`), w.php);
    const existing = c.customWidgets.find((x) => x.name === w.name);
    if (existing) existing.version++;
    else c.customWidgets.push({ name: w.name, title: w.title, replaces: w.replaces, forPage: page.title, version: 1 });
  }
  writeFileSync(join(pageDir(c, page.slug), `section-${s.index}.json`), JSON.stringify(out.elements));
  sec.status = "done";
  sec.widgets = out.widgets;
  sec.note = out.attempts > 1 ? "Fixed after validation feedback" : undefined;
  saveConversion(c);
  return out.customWidgets.length > 0;
}

/** Convert one page, push it as a draft, compare it with the HTML, then wait for approval. */
export async function convertPage(id: string, slug: string, opts: { feedback?: string; sectionIndex?: number } = {}) {
  const c = getConversion(id);
  if (!c) return;
  const page = c.pages.find((p) => p.slug === slug)!;
  c.status = "running";
  page.status = "converting";
  page.note = undefined;
  saveConversion(c);
  mkdirSync(pageDir(c, slug), { recursive: true });

  await checkConnection(c);
  const media = await ensureMedia(c);
  const htmlUrl = `http://127.0.0.1:${API_PORT}/files/builds/${c.buildId}/site/${fileFor(slug)}`;
  const digest = await digestPage(htmlUrl, pageDir(c, slug));
  if (!page.sections.length || page.sections.length !== digest.sections.length) {
    page.sections = digest.sections.map((s) => ({ index: s.index, label: sectionLabel(s), status: "pending", widgets: [] }));
  }
  saveConversion(c);

  // Header and footer are shared: convert them once per site and reuse.
  const sharedDir = join(convDir(c.id), "shared");
  mkdirSync(sharedDir, { recursive: true });
  let widgetsAdded = false;
  for (const s of digest.sections) {
    const sec = page.sections.find((x) => x.index === s.index)!;
    const shared = s.tag === "header" || s.tag === "footer" ? join(sharedDir, `${s.tag}.json`) : null;
    const target = join(pageDir(c, slug), `section-${s.index}.json`);
    const redo = opts.sectionIndex === undefined ? Boolean(opts.feedback) : opts.sectionIndex === s.index;
    if (shared && existsSync(shared) && !redo) {
      writeFileSync(target, readFileSync(shared));
      sec.status = "done";
      sec.note = "Shared with other pages";
      continue;
    }
    if (!redo && existsSync(target) && sec.status === "done") continue;
    widgetsAdded = (await convertAndStore(c, page, s, { fonts: digest.fonts, media }, redo ? opts.feedback : undefined)) || widgetsAdded;
    if (shared) writeFileSync(shared, readFileSync(target));
  }

  if (widgetsAdded) {
    c.pluginVersion++;
    await rebuildPlugin(c);
    saveConversion(c);
    await checkConnection(c); // throws NeedsUserError until the new plugin is installed
  }

  // Assemble and push.
  const elements: ElementorElement[] = [];
  let headerFooter: { header?: ElementorElement[]; footer?: ElementorElement[] } = {};
  for (const s of digest.sections) {
    const els = JSON.parse(readFileSync(join(pageDir(c, slug), `section-${s.index}.json`), "utf8")) as ElementorElement[];
    if (c.elementorPro && (s.tag === "header" || s.tag === "footer")) headerFooter = { ...headerFooter, [s.tag]: els };
    else elements.push(...els);
  }
  const a = auth(c);
  if (c.elementorPro) {
    // Pro: header/footer become theme-builder templates shown site-wide.
    for (const kind of ["header", "footer"] as const) {
      if (headerFooter[kind]) await upsertPage(a, { title: `${c.business} ${kind}`, slug: `studio-${kind}`, elementor_data: headerFooter[kind]!, kind });
    }
  }
  const pushed = await upsertPage(a, {
    page_id: page.wpPageId,
    title: page.title,
    slug: slug === "index" ? "home" : slug,
    elementor_data: elements,
    template: c.elementorPro ? "elementor_header_footer" : "elementor_canvas",
  });
  page.wpPageId = pushed.id;
  page.wpUrl = pushed.edit;
  page.previewUrl = pushed.preview;
  saveConversion(c);

  page.diff = await comparePages(htmlUrl, pushed.preview, pageDir(c, slug));
  page.status = "awaiting_approval";
  page.updatedAt = new Date().toISOString();
  page.feedback = undefined;
  c.status = "awaiting_approval";
  saveConversion(c);
  addEvent({ leadId: null, kind: "review", title: "WordPress page ready for approval", detail: `${c.business}: ${page.title} (${page.diff.desktop}% of pixels differ on desktop)` });
}

export function nextPendingPage(c: WpConversion) {
  return c.pages.find((p) => p.status === "pending" || p.status === "failed");
}

export function resumeConversions(enqueue: (id: string, slug: string) => void) {
  for (const c of listConversions()) {
    const p = c.pages.find((x) => x.status === "converting");
    if (p) enqueue(c.id, p.slug);
  }
}

export { ClaudeUnavailableError };
