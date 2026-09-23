import { Router } from "express";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { addEvent, getSettings } from "../db.ts";
import type { OnPageResult, QaResult, SeoPhase, SeoSite } from "../../shared/types.ts";
import { getConversion, getSecrets } from "../wp/store.ts";
import { pluginPath, rebuildPlugin } from "../wp/pipeline.ts";
import { buildPluginZip } from "../wp/plugin.ts";
import { WpError, ping, seoAlt, seoMeta, seoResolve, seoSchema, seoWebp, type WpAuth } from "../wp/client.ts";
import { discoverPages } from "./crawl.ts";
import { checkLinks, consistency, proofread, scanPages, testForm } from "./qa.ts";
import { runPerf } from "./perf.ts";
import { auditOnPage, proposeAlts, proposeMeta, proposeSchema } from "./onpage.ts";
import { buildChecklist, setChecklistItem } from "./checklist.ts";
import { createSite, deleteSiteRow, getSite, listSites, readResult, saveSite, setSiteSecret, siteDataDir, siteSecrets, writeResult } from "./store.ts";

/* ---------- auth + plugin (a linked WordPress conversion shares its connector) ---------- */

function siteAuth(s: SeoSite): WpAuth {
  if (s.conversionId) {
    const c = getConversion(s.conversionId);
    if (c) return { siteUrl: c.siteUrl, user: c.wpUser, appPassword: getSecrets(c.id).secret };
  }
  return { siteUrl: s.siteUrl, user: s.wpUser, appPassword: siteSecrets(s.id).secret };
}

export async function sitePlugin(s: SeoSite) {
  const conv = s.conversionId ? getConversion(s.conversionId) : null;
  if (conv) {
    await rebuildPlugin(conv); // same plugin (and preview token) as the conversion, now with SEO endpoints
    return pluginPath(conv);
  }
  const out = join(siteDataDir(s.id), "studio-connector.zip");
  await buildPluginZip(out, { version: 1, previewToken: siteSecrets(s.id).previewToken, widgets: [] });
  return out;
}

async function connect(s: SeoSite) {
  try {
    const p = await ping(siteAuth(s));
    if (!p.seo) throw new WpError("The connector on this site is too old for SEO. Download the plugin again from this page and update it.");
    s.connected = { ok: true, plugin: p.plugin, seoPlugin: p.seo_plugin ?? "", checkedAt: new Date().toISOString() };
  } catch (e) {
    s.connected = { ok: false, plugin: "", seoPlugin: "", checkedAt: new Date().toISOString() };
    saveSite(s);
    throw e;
  }
  saveSite(s);
}

/* ---------- one background job at a time ---------- */

type Job = { siteId: string; kind: SeoPhase | "forms" | "fixes"; run: (s: SeoSite, progress: (note: string) => void) => Promise<string>; done?: (error?: Error) => void };
const queue: Job[] = [];
let busy = false;

function enqueue(job: Job) {
  const s = getSite(job.siteId)!;
  s.runs[job.kind] = { status: "running", startedAt: new Date().toISOString(), note: "Queued" };
  saveSite(s);
  queue.push(job);
  void pump();
}

async function pump() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;
  const progress = (note: string) => {
    const s = getSite(job.siteId);
    if (!s) return;
    s.runs[job.kind] = { ...s.runs[job.kind]!, note };
    saveSite(s);
  };
  try {
    const s = getSite(job.siteId);
    if (!s) return; // deleted before it ran
    progress("Starting…");
    if (!s.pages.length && job.kind !== "fixes") {
      progress("Discovering pages…");
      s.pages = await discoverPages(s.siteUrl);
      saveSite(s);
    }
    const running = getSite(job.siteId);
    if (!running) return; // deleted mid-run
    const note = await job.run(running, progress);
    const done = getSite(job.siteId);
    if (!done) return; // deleted mid-run
    done.runs[job.kind] = { status: "done", startedAt: done.runs[job.kind]!.startedAt, finishedAt: new Date().toISOString(), note };
    done.error = undefined;
    saveSite(done);
    addEvent({ leadId: null, kind: "info", title: `${LABEL[job.kind]} finished`, detail: `${done.name}: ${note}` });
    job.done?.();
  } catch (e) {
    job.done?.(e as Error);
    const s = getSite(job.siteId);
    if (s) {
      s.runs[job.kind] = { ...s.runs[job.kind]!, status: "failed", finishedAt: new Date().toISOString(), note: (e as Error).message.slice(0, 300) };
      s.error = (e as Error).message.slice(0, 300);
      saveSite(s);
    }
    console.error(`[seo ${job.siteId} ${job.kind}]`, e);
  } finally {
    busy = false;
    void pump();
  }
}

const LABEL = { qa: "Post-launch QA", perf: "Performance audit", onpage: "On-page SEO audit", forms: "Form tests", fixes: "SEO fixes" } as const;

/* ---------- jobs ---------- */

async function runQa(s: SeoSite, progress: (n: string) => void) {
  const urls = s.pages.map((p) => p.url);
  progress(`Reading ${urls.length} pages…`);
  const scan = await scanPages(urls);
  const previous = readResult<QaResult>(s.id, "qa");
  const forms = scan.forms.map((f) => ({ ...f, test: previous?.forms.find((o) => o.page === f.page && o.index === f.index)?.test }));
  progress("Checking links…");
  const links = await checkLinks(scan.links, new URL(s.siteUrl).origin);
  progress("Proofreading every page…");
  const issues = await proofread(s.id, siteDataDir(s.id), scan.texts);
  progress("Comparing contact details across pages…");
  const cons = await consistency(s.id, siteDataDir(s.id), scan.texts);
  writeResult(s.id, "qa", { forms, issues, consistency: cons, links } satisfies QaResult);
  return `${forms.length} forms found, ${issues.length} text issues, ${cons.filter((c) => c.verdict === "inconsistent").length} inconsistencies, ${links.length} broken links`;
}

async function runForms(s: SeoSite, progress: (n: string) => void, only?: { page: string; index: number }) {
  const qa = readResult<QaResult>(s.id, "qa");
  if (!qa) throw new Error("Run post-launch QA first so the forms are found");
  const email = getSettings().qaEmail || getSettings().userEmail;
  if (!email) throw new Error("Set a QA email address under Settings → Integrations first. Test submissions use it.");
  const targets = qa.forms.filter((f) => !only || (f.page === only.page && f.index === only.index));
  for (let i = 0; i < targets.length; i++) {
    progress(`Testing form ${i + 1} of ${targets.length}…`);
    targets[i].test = await testForm(targets[i], email, siteDataDir(s.id));
    writeResult(s.id, "qa", qa);
  }
  const ok = targets.filter((f) => f.test?.ok).length;
  return `${ok}/${targets.length} forms confirmed working`;
}

async function runOnpage(s: SeoSite, progress: (n: string) => void) {
  progress(`Auditing ${s.pages.length} pages and their images…`);
  const sitemap = await fetch(new URL("/wp-sitemap.xml", s.siteUrl)).then((r) => (r.ok ? r.url : "")).catch(() => "")
    || await fetch(new URL("/sitemap.xml", s.siteUrl)).then((r) => (r.ok ? r.url : "")).catch(() => "");
  const { result, extra } = await auditOnPage(s.pages.map((p) => p.url), sitemap);
  // Keep proposals from an earlier run where the page/image still exists.
  const prev = readResult<OnPageResult>(s.id, "onpage");
  for (const p of result.pages) {
    const old = prev?.pages.find((x) => x.url === p.url);
    if (old?.proposed) p.proposed = old.proposed;
    if (old?.schema) p.schema = old.schema;
  }
  for (const i of result.images) {
    const old = prev?.images.find((x) => x.src === i.src);
    if (old?.proposedAlt !== undefined) i.proposedAlt = old.proposedAlt;
    if (old?.altApplied) i.altApplied = old.altApplied;
    if (old?.webp) i.webp = old.webp;
  }
  writeResult(s.id, "onpage", result);
  writeResult(s.id, "onpage-extra", extra);
  return `${result.pages.length} pages, ${result.images.length} images audited`;
}

async function runProposals(s: SeoSite, kind: "meta" | "alt" | "schema", progress: (n: string) => void) {
  const onpage = readResult<OnPageResult>(s.id, "onpage");
  const extra = readResult<Parameters<typeof proposeMeta>[3]>(s.id, "onpage-extra");
  if (!onpage || !extra) throw new Error("Run the on-page audit first");
  const cwd = siteDataDir(s.id);
  if (kind === "meta") {
    progress("Writing meta titles and descriptions…");
    const out = await proposeMeta(s.id, cwd, onpage.pages, extra, s.name);
    for (const p of onpage.pages) {
      const m = out.find((o) => o.url === p.url);
      if (m) p.proposed = { title: m.title.trim(), description: m.description.trim() };
    }
  } else if (kind === "alt") {
    progress("Looking at images and writing alt text…");
    const out = await proposeAlts(s.id, cwd, onpage.images, extra);
    for (const r of out) {
      const img = onpage.images.find((i) => i.src === r.src);
      if (img) img.proposedAlt = r.alt;
    }
  } else {
    const origin = new URL(s.siteUrl).origin;
    const home = onpage.pages.find((p) => new URL(p.url).pathname === "/") ?? onpage.pages[0];
    for (let i = 0; i < onpage.pages.length; i++) {
      const p = onpage.pages[i];
      progress(`Writing schema for page ${i + 1} of ${onpage.pages.length}…`);
      p.schema = await proposeSchema(s.id, cwd, p, extra[p.url], { name: s.name, origin, homeText: extra[home.url]?.text ?? "", isHome: p === home });
      writeResult(s.id, "onpage", onpage);
    }
  }
  writeResult(s.id, "onpage", onpage);
  return kind === "meta" ? `${onpage.pages.filter((p) => p.proposed).length} titles/descriptions drafted`
    : kind === "alt" ? `${onpage.images.filter((i) => i.proposedAlt !== undefined).length} alt texts drafted`
    : `${onpage.pages.filter((p) => p.schema?.jsonld).length} pages have schema drafted`;
}

async function runFixes(s: SeoSite, kinds: ("meta" | "alt" | "schema" | "webp")[], progress: (n: string) => void) {
  if (!s.qaSignedOff) throw new Error("Mark post-launch QA as complete before applying SEO fixes");
  await connect(s);
  const auth = siteAuth(s);
  const onpage = readResult<OnPageResult>(s.id, "onpage");
  if (!onpage) throw new Error("Run the on-page audit first");
  const ids = readResult<Record<string, { post_id: number; attachment_id: number }>>(s.id, "wp-ids") ?? {};
  const resolve = async (url: string) => (ids[url] ??= await seoResolve(auth, url));
  const done: string[] = [];

  if (kinds.includes("meta")) {
    let n = 0;
    for (const p of onpage.pages.filter((x) => x.proposed && !x.proposed.applied)) {
      progress(`Meta: ${new URL(p.url).pathname}`);
      const { post_id } = await resolve(p.url);
      if (!post_id) continue;
      await seoMeta(auth, { post_id, title: p.proposed!.title, description: p.proposed!.description });
      p.proposed!.applied = true;
      n++;
      writeResult(s.id, "onpage", onpage);
    }
    done.push(`${n} meta updated`);
  }
  if (kinds.includes("schema")) {
    let n = 0;
    for (const p of onpage.pages.filter((x) => x.schema?.jsonld && !x.schema.errors.length && !x.schema.applied)) {
      progress(`Schema: ${new URL(p.url).pathname}`);
      const { post_id } = await resolve(p.url);
      if (!post_id) continue;
      await seoSchema(auth, { post_id, jsonld: p.schema!.jsonld });
      p.schema!.applied = true;
      n++;
      writeResult(s.id, "onpage", onpage);
    }
    done.push(`${n} pages got schema`);
  }
  if (kinds.includes("alt")) {
    let n = 0;
    for (const img of onpage.images.filter((i) => i.proposedAlt !== undefined && !i.altApplied)) {
      progress(`Alt text: ${img.src.split("/").pop()}`);
      const { attachment_id } = await resolve(img.src);
      if (!attachment_id) continue;
      await seoAlt(auth, { attachment_id, alt: img.proposedAlt! });
      img.altApplied = true;
      n++;
      writeResult(s.id, "onpage", onpage);
    }
    done.push(`${n} alt texts set`);
  }
  if (kinds.includes("webp")) {
    let n = 0;
    let saved = 0;
    for (const img of onpage.images.filter((i) => ["jpg", "png"].includes(i.format) && i.webp?.status !== "done")) {
      progress(`WebP: ${img.src.split("/").pop()}`);
      const { attachment_id } = await resolve(img.src);
      if (!attachment_id) {
        img.webp = { status: "failed", before: img.bytes ?? 0, after: 0, note: "Not in the media library (theme or external image)" };
        continue;
      }
      try {
        const r = await seoWebp(auth, { attachment_id, quality: 80 });
        img.webp = { status: "done", before: r.before, after: r.after, note: r.skipped };
        saved += Math.max(0, r.before - r.after);
        n++;
      } catch (e) {
        img.webp = { status: "failed", before: img.bytes ?? 0, after: 0, note: (e as Error).message.slice(0, 120) };
      }
      writeResult(s.id, "onpage", onpage);
    }
    done.push(`${n} images → WebP (${Math.round(saved / 1024)} KB saved)`);
  }
  writeResult(s.id, "wp-ids", ids);
  return done.join(" · ");
}

async function runPerfPhase(site: SeoSite, progress: (n: string) => void) {
  const settings = getSettings() as unknown as { psiKey: string; gtmetrixKey: string };
  const perf = await runPerf(site.pages.map((p) => p.url), { psi: settings.psiKey, gtmetrix: settings.gtmetrixKey }, (n) => progress(`Measured ${n} of ${site.pages.length} pages…`));
  writeResult(site.id, "perf", perf);
  const avg = Math.round(perf.pages.reduce((a, p) => a + (p.mobile?.score ?? 0), 0) / Math.max(1, perf.pages.length));
  return `${perf.pages.length} pages measured, average mobile score ${avg}`;
}

/** Used by maintenance: queue an audit phase and wait for it (never submits forms). */
export function runSeoPhase(siteId: string, phase: SeoPhase) {
  return new Promise<void>((resolve, reject) => {
    const run = phase === "qa" ? runQa : phase === "onpage" ? runOnpage : runPerfPhase;
    enqueue({ siteId, kind: phase, run, done: (e) => (e ? reject(e) : resolve()) });
  });
}

/* ---------- routes ---------- */

export const seo = Router();

seo.get("/", (_req, res) => res.json(listSites()));

seo.post("/", (req, res) => {
  const conv = req.body?.conversionId ? getConversion(String(req.body.conversionId)) : null;
  let siteUrl = String(req.body?.siteUrl ?? conv?.siteUrl ?? "");
  try {
    siteUrl = new URL(siteUrl).origin;
  } catch {
    return res.status(400).json({ error: "Enter the live site URL, e.g. https://client-site.com" });
  }
  const s = createSite({
    name: String(req.body?.name ?? conv?.business ?? new URL(siteUrl).hostname).trim(),
    siteUrl,
    conversionId: conv?.id ?? null,
    wpUser: conv ? conv.wpUser : String(req.body?.wpUser ?? "").trim(),
    appPassword: conv ? "" : String(req.body?.appPassword ?? "").trim(),
  });
  res.json(s);
});

seo.get("/:id", (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  res.json({ ...s, busy: queue.some((j) => j.siteId === s.id) || s.runs && Object.values(s.runs).some((r) => r?.status === "running") });
});

seo.get("/:id/results", (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  res.json({ qa: readResult(s.id, "qa"), perf: readResult(s.id, "perf"), onpage: readResult(s.id, "onpage"), checklist: buildChecklist(s) });
});

seo.put("/:id/credentials", (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  if (s.conversionId) return res.status(409).json({ error: "This site uses its WordPress conversion's connection" });
  if (typeof req.body?.wpUser === "string") s.wpUser = req.body.wpUser.trim();
  if (typeof req.body?.appPassword === "string" && req.body.appPassword.trim()) {
    setSiteSecret(s.id, req.body.appPassword.trim());
    s.appPasswordSet = true;
  }
  saveSite(s);
  res.json(s);
});

seo.post("/:id/test", async (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  try {
    await connect(s);
    res.json({ ok: true, connected: getSite(s.id)!.connected });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

seo.get("/:id/plugin", async (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  const file = await sitePlugin(s);
  if (!existsSync(file)) return res.sendStatus(404);
  res.download(file, "studio-connector.zip");
});

seo.post("/:id/pages/discover", (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  s.pages = [];
  saveSite(s);
  enqueue({ siteId: s.id, kind: "qa", run: runQa });
  res.json({ ok: true });
});

seo.post("/:id/run/:phase", (req, res) => {
  const s = getSite(req.params.id);
  const phase = req.params.phase as SeoPhase;
  if (!s || !["qa", "perf", "onpage"].includes(phase)) return res.sendStatus(404);
  if (s.runs[phase]?.status === "running") return res.status(409).json({ error: "Already running" });
  const run = phase === "qa" ? runQa : phase === "onpage" ? runOnpage : runPerfPhase;
  enqueue({ siteId: s.id, kind: phase, run });
  res.json({ ok: true });
});

/** Sends real test submissions: only ever triggered by an explicit click. */
seo.post("/:id/forms/test", (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  if (req.body?.confirm !== true) return res.status(400).json({ error: "Confirm that test submissions may be sent" });
  const only = req.body?.page ? { page: String(req.body.page), index: Number(req.body.index) } : undefined;
  enqueue({ siteId: s.id, kind: "forms", run: (site, progress) => runForms(site, progress, only) });
  res.json({ ok: true });
});

seo.post("/:id/signoff", (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  s.qaSignedOff = Boolean(req.body?.value);
  saveSite(s);
  res.json(s);
});

seo.post("/:id/propose/:kind", (req, res) => {
  const s = getSite(req.params.id);
  const kind = req.params.kind as "meta" | "alt" | "schema";
  if (!s || !["meta", "alt", "schema"].includes(kind)) return res.sendStatus(404);
  enqueue({ siteId: s.id, kind: "onpage", run: (site, progress) => runProposals(site, kind, progress) });
  res.json({ ok: true });
});

/** Edit a proposal before applying it. */
seo.put("/:id/proposals", (req, res) => {
  const s = getSite(req.params.id);
  const onpage = s && readResult<OnPageResult>(s.id, "onpage");
  if (!s || !onpage) return res.sendStatus(404);
  const { url, title, description, src, alt } = req.body ?? {};
  if (url) {
    const p = onpage.pages.find((x) => x.url === url);
    if (p) p.proposed = { title: String(title ?? p.proposed?.title ?? ""), description: String(description ?? p.proposed?.description ?? ""), applied: false };
  }
  if (src) {
    const i = onpage.images.find((x) => x.src === src);
    if (i) {
      i.proposedAlt = String(alt ?? "");
      i.altApplied = false;
    }
  }
  writeResult(s.id, "onpage", onpage);
  res.json({ ok: true });
});

seo.post("/:id/apply", (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  if (!s.qaSignedOff) return res.status(409).json({ error: "Finish post-launch QA first: mark it complete on the QA tab" });
  const kinds = (Array.isArray(req.body?.kinds) ? req.body.kinds : []).filter((k: string) => ["meta", "alt", "schema", "webp"].includes(k));
  if (!kinds.length) return res.status(400).json({ error: "Nothing to apply" });
  enqueue({ siteId: s.id, kind: "fixes", run: (site, progress) => runFixes(site, kinds, progress) });
  res.json({ ok: true });
});

seo.put("/:id/checklist/:item", (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  setChecklistItem(s.id, req.params.item, req.body?.status === "done" ? "done" : "todo");
  res.json(buildChecklist(s));
});

seo.delete("/:id", (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  if (queue.some((j) => j.siteId === s.id)) return res.status(409).json({ error: "Wait for the running job to finish" });
  deleteSiteRow(s.id);
  rmSync(siteDataDir(s.id), { recursive: true, force: true });
  res.json({ ok: true });
});
