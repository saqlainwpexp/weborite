import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error archiver v8 ships without type declarations
import { ZipArchive } from "archiver";
import { API_PORT, addEvent, leadDir, readJson } from "../db.ts";
import { ClaudeUnavailableError, extractFenced, runClaude } from "../claude/runner.ts";
import { SYSTEM as MOCKUP_SYSTEM, buildFactsBlock } from "../pipeline/generate.ts";
import { inspectPage } from "../pipeline/gate.ts";
import { newContext } from "../pipeline/browser.ts";
import { googleFonts, isGoogleFamily, primaryFamily } from "../fonts.ts";
import type { Build, BuildPage, BuildStepKey, Capture, Diagnosis, Fact, GateCheck } from "../../shared/types.ts";
import { buildDir, getBuild, partsDir, saveBuild, siteDir } from "./store.ts";

/* ---------- shared layout ---------- */

export interface Layout {
  lang: string;
  headExtras: string;   // font links, favicons
  styles: string;       // becomes styles.css
  scripts: string;      // becomes site.js
  header: string;
  footer: string;
  prefix: string;       // body content before <header> (skip links, top bars)
  between: string;      // between </header> and <main>
  after: string;        // between </main> and <footer> (e.g. sticky mobile CTA)
  homeMain: string;
  homeDescription: string;
}

interface Ctx {
  build: Build;
  capture: Capture;
  diagnosis: Diagnosis;
  facts: Fact[];
}

const layoutPath = (id: string) => join(partsDir(id), "layout.json");
const pagePartPath = (id: string, slug: string) => join(partsDir(id), `page-${slug}.json`);
const fileFor = (slug: string) => (slug === "index" ? "index.html" : `${slug}.html`);

function loadCtx(build: Build): Ctx {
  const capture = readJson<Capture>(build.leadId, "capture.json");
  const diagnosis = readJson<Diagnosis>(build.leadId, "diagnosis.json");
  const facts = readJson<Fact[]>(build.leadId, "facts.json");
  if (!capture || !diagnosis || !facts) throw new Error("The mockup lead is missing its capture or diagnosis. Re-run the mockup first.");
  return { build, capture, diagnosis, facts };
}

/** Pull `===NAME===` sections out of a Claude reply. */
function sections(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = extractFenced(text, "html").includes("===") ? extractFenced(text, "html") : text;
  const re = /===([A-Z]+)===\s*\n?([\s\S]*?)(?=\n?===[A-Z]+===|$)/g;
  for (const m of body.matchAll(re)) out[m[1]] = m[2].replace(/^```\w*\n?|```\s*$/g, "").trim();
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Split the approved homepage into shared parts without executing its scripts. */
async function splitHomepage(html: string): Promise<Layout> {
  const ctx = await newContext({ javaScriptEnabled: false });
  try {
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    return await page.evaluate(() => {
      const outer = (els: Element[]) => els.map((e) => e.outerHTML).join("\n");
      const header = document.querySelector("body > header") ?? document.querySelector("header");
      const main = document.querySelector("main");
      const footers = Array.from(document.querySelectorAll("footer"));
      const footer = document.querySelector("body > footer") ?? footers[footers.length - 1] ?? null;
      const kids = Array.from(document.body.children).filter((e) => e.tagName !== "SCRIPT" && e.tagName !== "NOSCRIPT");
      const idx = (el: Element | null) => (el ? kids.indexOf(el) : -1);
      const [h, m, f] = [idx(header), idx(main), idx(footer)];
      const slice = (a: number, b: number) => (a >= -1 && b > a ? kids.slice(a + 1, b) : []);
      return {
        lang: document.documentElement.lang || "en",
        headExtras: outer(Array.from(document.head.querySelectorAll('link[rel="preconnect"], link[href*="fonts."], link[rel~="icon"]'))),
        styles: Array.from(document.querySelectorAll("style")).map((s) => s.textContent ?? "").join("\n\n"),
        scripts: Array.from(document.querySelectorAll("script:not([src])"))
          .filter((s) => !/json/i.test(s.getAttribute("type") ?? ""))
          .map((s) => s.textContent ?? "").join("\n\n"),
        header: header?.outerHTML ?? "",
        footer: footer?.outerHTML ?? "",
        prefix: h > 0 ? outer(kids.slice(0, h)) : "",
        between: h >= 0 && m > h ? outer(slice(h, m)) : "",
        after: m >= 0 ? outer(kids.slice(m + 1, f > m ? f : undefined).filter((e) => e !== footer)) : "",
        homeMain: main?.outerHTML ?? "",
        homeDescription: document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "",
      };
    });
  } finally {
    await ctx.close();
  }
}

const fixAssetPaths = (s: string) => s.replace(/\.\.\/assets\//g, "assets/");

function assemble(build: Build, layout: Layout, page: BuildPage, part: { main: string; css: string; description: string }) {
  const markActive = (html: string) =>
    html.replace(new RegExp(`(<a\\b[^>]*data-page="${page.slug}"[^>]*?)(\\s*/?)>`, "g"), (_m, a, b) => (/aria-current=/.test(a) ? `${a}${b}>` : `${a} aria-current="page"${b}>`));
  const title = page.slug === "index" ? build.business : `${page.title} | ${build.business}`;
  return `<!doctype html>
<html lang="${esc(layout.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(part.description || layout.homeDescription || build.business)}">
${layout.headExtras}
<link rel="stylesheet" href="styles.css">
${part.css.trim() ? `<style>\n${part.css}\n</style>` : ""}
</head>
<body data-page="${page.slug}">
${layout.prefix}
${markActive(layout.header)}
${layout.between}
${part.main}
${layout.after}
${markActive(layout.footer)}
${layout.scripts.trim() ? '<script src="site.js"></script>' : ""}
</body>
</html>
`;
}

const idsIn = (html: string) => new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));

/**
 * Nav links are written before the pages exist, so "about.html#story" can point at a
 * section the About page never got. Point those at the page itself instead.
 */
function repairAnchors(html: string, ids: Map<string, Set<string>>) {
  return html.replace(/href=(["'])([\w-]+\.html)#([\w-]+)\1/g, (m, q, file, hash) => (ids.get(file)?.has(hash) ? m : `href=${q}${file}${q}`));
}

function writeSiteFiles(build: Build, layout: Layout) {
  const dir = siteDir(build.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "styles.css"), layout.styles);
  if (layout.scripts.trim()) writeFileSync(join(dir, "site.js"), layout.scripts);
  const shared = [layout.prefix, layout.header, layout.between, layout.after, layout.footer].join("\n");
  const pages = build.pages
    .filter((p) => existsSync(pagePartPath(build.id, p.slug)))
    .map((p) => ({ page: p, part: JSON.parse(readFileSync(pagePartPath(build.id, p.slug), "utf8")) as { main: string; css: string; description: string } }));
  const ids = new Map(pages.map(({ page, part }) => [fileFor(page.slug), new Set([...idsIn(part.main), ...idsIn(shared)])]));
  for (const { page, part } of pages) writeFileSync(join(dir, fileFor(page.slug)), repairAnchors(assemble(build, layout, page, part), ids));
}

/* ---------- Claude steps ---------- */

const BUILD_SYSTEM = `${MOCKUP_SYSTEM}

You're now extending an approved homepage into a complete multi-page website. Every page shares the homepage's header, footer and styles.css, so pages must look like they belong to the same site. Reuse existing classes and patterns from styles.css first; add page-specific CSS only for genuinely new components. The client's project details count as FACTS too.`;

function pagesList(build: Build) {
  return build.pages.map((p) => `- ${p.title} → ${fileFor(p.slug)} (data-page="${p.slug}")${p.brief ? `: ${p.brief}` : ""}`).join("\n");
}

function factsFor(ctx: Ctx) {
  const extra = [ctx.build.details, ctx.build.homepageChanges, ...ctx.build.pages.map((p) => p.brief)].filter(Boolean);
  return [...ctx.facts.map((f) => f.text), ...extra];
}

/** Font families used for text that aren't available on Google Fonts. */
async function nonGoogleFonts(html: string) {
  const gf = await googleFonts();
  const ctx = await newContext({ javaScriptEnabled: false });
  try {
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    const stacks = await page.evaluate(() => [...new Set(Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .filter((el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || "").trim().length > 1))
      .map((el) => getComputedStyle(el).fontFamily))]);
    return [...new Set(stacks.map(primaryFamily))].filter((f) => f && !isGoogleFamily(f, gf));
  } finally {
    await ctx.close();
  }
}

function fontInstruction(fonts: string[]) {
  return `Switch every font to Google Fonts. These families aren't on Google Fonts, so WordPress/Elementor can't load them: ${fonts.join(", ")}.
Replace each with the closest Google Fonts family in the same style (a transitional serif like Iowan Old Style → Source Serif 4 or Libre Caslon Text; a neo-grotesque like Helvetica Neue → Inter), load them with one <link> to fonts.googleapis.com (with preconnect), and keep sizes, weights and spacing the same so the layout doesn't shift.`;
}

async function reviseHomepage(ctx: Ctx, html: string, changes: string) {
  const res = await runClaude({
    leadId: ctx.build.leadId, task: "build", cwd: buildDir(ctx.build.id), heavy: true, system: MOCKUP_SYSTEM,
    prompt: `The client approved this homepage mockup. Apply these changes:

${changes}

PROJECT DETAILS FROM THE CLIENT (these count as facts):
${ctx.build.details || "(none yet)"}

FACTS from the original site:
${buildFactsBlock(ctx.facts)}

Apply every requested change and keep everything else exactly as it is. Keep the same asset paths (../assets/...), brand colours and logo.

Current HTML:
\`\`\`html
${html}
\`\`\`

Return the full updated document in a single \`\`\`html block.`,
  });
  const out = extractFenced(res.text, "html");
  if (!/<main[\s>]/i.test(out) || !/<\/html>/i.test(out)) throw new Error("Claude did not return a complete homepage");
  return out.slice(out.search(/<!doctype html|<html/i));
}

async function linkNavigation(ctx: Ctx, layout: Layout) {
  const res = await runClaude({
    leadId: ctx.build.leadId, task: "build", cwd: buildDir(ctx.build.id), system: BUILD_SYSTEM,
    prompt: `Update this site's header and footer navigation for the full website.

PAGES:
${pagesList(ctx.build)}

Rules:
- The main nav links to every page above using its file name. Give each nav link data-page="<slug>" exactly as listed. Keep the existing classes, structure, logo and mobile menu button.
- Turn in-page anchors (#services and so on) into links to the matching page. Keep the primary call-to-action button, pointing it at the most relevant page (usually contact.html if it exists).
- In the footer, add a simple link list to all pages (with the same data-page attributes) if it doesn't already have one.
- Add CSS for the current page state: a[aria-current="page"] { ... }. It must be subtle, use the existing brand colours and keep AA contrast.

CURRENT HEADER:
${layout.header}

CURRENT FOOTER:
${layout.footer || "(none: write a simple footer with the logo, contact details from FACTS and page links)"}

FACTS (only for contact details in the footer):
${buildFactsBlock(ctx.facts).slice(0, 6000)}

Reply in exactly this format and nothing else:
===HEADER===
<header ...>...</header>
===FOOTER===
<footer ...>...</footer>
===CSS===
(the new CSS rules only)
===END===`,
  });
  const s = sections(res.text);
  if (!/<header[\s>]/i.test(s.HEADER ?? "")) throw new Error("Claude did not return an updated header");
  return { header: s.HEADER, footer: /<footer[\s>]/i.test(s.FOOTER ?? "") ? s.FOOTER : layout.footer, css: s.CSS ?? "" };
}

async function writePage(ctx: Ctx, layout: Layout, page: BuildPage, mode: { current?: { main: string; css: string }; changes?: string; failures?: GateCheck[] } = {}) {
  const dir = buildDir(ctx.build.id);
  const ref = join(dir, "ref-home.jpg");
  const others = ctx.capture.assets.map((a) => (/^https?:/.test(a.path) ? a.path : a.path)).filter((p) => !/^https?:/.test(p));
  const task = mode.current
    ? `REVISE the ${page.title} page (${fileFor(page.slug)}).
${mode.changes ? `Requested changes:\n${mode.changes}\n` : ""}${mode.failures?.length ? `It failed these automated checks. Fix every one:\n${mode.failures.map((f) => `- ${f.name}: ${f.detail}`).join("\n")}\n` : ""}
Current page CSS:
${mode.current.css || "(none)"}

Current <main>:
${mode.current.main}`
    : `WRITE the ${page.title} page (${fileFor(page.slug)}).
What it should cover: ${page.brief || `a standard ${page.title} page for this business`}`;

  const res = await runClaude({
    leadId: ctx.build.leadId, task: "build", cwd: dir, heavy: true, system: BUILD_SYSTEM,
    images: existsSync(ref) ? [ref] : [],
    prompt: `${task}

The page is assembled as: shared header → your <main> → shared footer, with styles.css loaded. Write ONLY the <main> element (and optional page-specific CSS). Don't repeat the header, footer or nav.

SITE PAGES (link between them with these file names):
${pagesList(ctx.build)}

SHARED styles.css (reuse these classes):
\`\`\`css
${layout.styles.slice(0, 40000)}
\`\`\`

HOMEPAGE <main> (the approved design language to follow):
${layout.homeMain.slice(0, 30000)}

ASSETS you may use (paths relative to the page): ${others.map((p) => fixAssetPaths(`../${p}`)).join(", ") || "none"}
Logo: ${ctx.capture.logo ? fixAssetPaths(`../${ctx.capture.logo.path}`) : "text wordmark"}
Brand colours (locked): ${JSON.stringify(ctx.diagnosis.brand)}

PROJECT DETAILS FROM THE CLIENT (count as facts):
${ctx.build.details || "(none provided)"}

FACTS from the original site:
${buildFactsBlock(ctx.facts)}

Rules for this page: use only the Google Fonts already loaded by the site (don't add other font families); exactly one <h1>; every class you use must exist in styles.css or in your page CSS; no invented numbers, testimonials, team members, prices or awards. If the details don't cover something, write it without specifics or leave it out. Any form must be static HTML with a clear submit button (action="#").

Reply in exactly this format and nothing else:
===DESCRIPTION===
(one-sentence meta description)
===CSS===
(page-specific CSS, or leave empty)
===MAIN===
<main>...</main>
===END===`,
  });
  const s = sections(res.text);
  const main = (s.MAIN ?? "").match(/<main[\s>][\s\S]*<\/main>/i)?.[0];
  if (!main) throw new Error(`Claude did not return a <main> for ${page.title}`);
  const part = { main: fixAssetPaths(main), css: fixAssetPaths(s.CSS ?? ""), description: (s.DESCRIPTION ?? "").replace(/\s+/g, " ").trim().slice(0, 300) };
  writeFileSync(pagePartPath(ctx.build.id, page.slug), JSON.stringify(part));
  return part;
}

/* ---------- checks ---------- */

async function checkPage(ctx: Ctx, page: BuildPage) {
  const url = `http://127.0.0.1:${API_PORT}/files/builds/${ctx.build.id}/site/${fileFor(page.slug)}?t=${Date.now()}`;
  const { checks } = await inspectPage(url, {
    facts: factsFor(ctx),
    strongestAsset: page.slug === "index" ? ctx.diagnosis.strongestAsset : null,
    logo: ctx.capture.logo,
    brand: ctx.diagnosis.brand,
  });
  page.checks = checks;
  page.pass = checks.every((c) => c.pass);
  return page.pass;
}

async function checkLinks(build: Build): Promise<GateCheck> {
  const ctx = await newContext({});
  const broken: string[] = [];
  try {
    const page = await ctx.newPage();
    const ids = new Map<string, Set<string>>();
    const links: { from: string; href: string }[] = [];
    for (const p of build.pages) {
      await page.goto(`http://127.0.0.1:${API_PORT}/files/builds/${build.id}/site/${fileFor(p.slug)}`, { waitUntil: "domcontentloaded" });
      const r = await page.evaluate(() => ({
        ids: Array.from(document.querySelectorAll("[id]")).map((e) => e.id),
        hrefs: Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")!),
      }));
      ids.set(fileFor(p.slug), new Set(r.ids));
      for (const href of r.hrefs) links.push({ from: fileFor(p.slug), href });
    }
    for (const { from, href } of links) {
      if (/^(https?:|mailto:|tel:|javascript:|\/\/)/i.test(href) || href === "#") continue;
      const [file, hash] = href.split("#");
      const target = file ? file.replace(/^\.\//, "") : from;
      if (!ids.has(target)) broken.push(`${from} → ${href}`);
      else if (hash && !ids.get(target)!.has(hash)) broken.push(`${from} → ${href} (no #${hash})`);
    }
  } finally {
    await ctx.close();
  }
  const uniq = [...new Set(broken)];
  return { name: "Internal links", pass: uniq.length === 0, detail: uniq.length ? `Broken: ${uniq.slice(0, 8).join("; ")}` : "Every internal link and anchor resolves" };
}

async function packageSite(build: Build) {
  const zipPath = join(buildDir(build.id), "site.zip");
  rmSync(zipPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(zipPath);
    const zip = new ZipArchive({ zlib: { level: 6 } });
    out.on("close", () => resolve());
    zip.on("error", reject);
    zip.pipe(out);
    zip.directory(siteDir(build.id), false);
    void zip.finalize();
  });
}

/* ---------- runner ---------- */

function step(build: Build, key: BuildStepKey) {
  return build.steps.find((s) => s.key === key)!;
}

async function doStep(build: Build, key: BuildStepKey, fn: () => Promise<string | void>) {
  const s = step(build, key);
  if (s.status === "done") return;
  s.status = "running";
  s.startedAt = new Date().toISOString();
  s.note = undefined;
  saveBuild(build);
  try {
    s.note = (await fn()) || undefined;
    s.status = "done";
  } catch (e) {
    s.status = e instanceof ClaudeUnavailableError ? "pending" : "failed";
    s.note = (e as Error).message.slice(0, 300);
    throw e;
  } finally {
    s.finishedAt = new Date().toISOString();
    saveBuild(build);
  }
}

export async function runBuild(id: string) {
  const build = getBuild(id);
  if (!build) return;
  build.status = "running";
  build.error = undefined;
  saveBuild(build);
  const ctx = loadCtx(build);
  const dir = buildDir(id);

  // Reference screenshot + assets travel with the build.
  const shot = join(leadDir(build.leadId), "mockup-desktop.jpg");
  if (existsSync(shot)) cpSync(shot, join(dir, "ref-home.jpg"));
  const assets = join(leadDir(build.leadId), "assets");
  if (existsSync(assets)) cpSync(assets, join(siteDir(id), "assets"), { recursive: true });

  await doStep(build, "homepage", async () => {
    const approved = readFileSync(join(leadDir(build.leadId), "mockup", "index.html"), "utf8");
    const badFonts = await nonGoogleFonts(approved);
    const changes = [build.homepageChanges.trim(), badFonts.length ? fontInstruction(badFonts) : ""].filter(Boolean).join("\n\n");
    const html = changes ? await reviseHomepage(ctx, approved, changes) : approved;
    writeFileSync(join(partsDir(id), "homepage.html"), html);
    const notes = [build.homepageChanges.trim() ? "Changes applied" : "", badFonts.length ? `Fonts switched to Google Fonts (was ${badFonts.join(", ")})` : ""].filter(Boolean);
    return notes.join(" · ") || "No changes requested; approved mockup used as-is";
  });

  await doStep(build, "layout", async () => {
    const html = readFileSync(join(partsDir(id), "homepage.html"), "utf8");
    const layout = await splitHomepage(html);
    if (!layout.header || !layout.homeMain) throw new Error("The homepage needs a <header> and a <main> to share across pages");
    const nav = await linkNavigation(ctx, layout);
    const final: Layout = {
      ...layout,
      header: fixAssetPaths(nav.header),
      footer: fixAssetPaths(nav.footer),
      prefix: fixAssetPaths(layout.prefix),
      between: fixAssetPaths(layout.between),
      after: fixAssetPaths(layout.after),
      styles: fixAssetPaths(`${layout.styles}\n\n/* Navigation: current page */\n${nav.css}`),
      homeMain: fixAssetPaths(layout.homeMain),
    };
    writeFileSync(layoutPath(id), JSON.stringify(final));
    writeFileSync(pagePartPath(id, "index"), JSON.stringify({ main: final.homeMain, css: "", description: final.homeDescription }));
    const home = build.pages[0];
    home.status = "done";
    home.updatedAt = new Date().toISOString();
    return `Header, footer and styles shared across ${build.pages.length} pages`;
  });
  const layout = JSON.parse(readFileSync(layoutPath(id), "utf8")) as Layout;

  await doStep(build, "pages", async () => {
    for (const p of build.pages.slice(1)) {
      if (p.status === "done") continue;
      p.status = "running";
      saveBuild(build);
      try {
        await writePage(ctx, layout, p);
        p.status = "done";
        p.updatedAt = new Date().toISOString();
      } catch (e) {
        p.status = e instanceof ClaudeUnavailableError ? "pending" : "failed";
        p.note = (e as Error).message.slice(0, 200);
        saveBuild(build);
        throw e;
      }
      saveBuild(build);
    }
    writeSiteFiles(build, layout);
    return `${build.pages.length} pages written`;
  });

  await doStep(build, "checks", async () => {
    writeSiteFiles(build, layout);
    for (const p of build.pages) {
      p.attempts = 0;
      await checkPage(ctx, p);
      // One automatic fix per failing page, like the mockup gate.
      if (!p.pass && p.attempts < 1) {
        p.attempts++;
        const current = JSON.parse(readFileSync(pagePartPath(id, p.slug), "utf8"));
        await writePage(ctx, layout, p, { current, failures: p.checks.filter((c) => !c.pass) });
        writeSiteFiles(build, layout);
        await checkPage(ctx, p);
      }
      saveBuild(build);
    }
    build.linkCheck = await checkLinks(build);
    const failing = build.pages.filter((p) => !p.pass).length;
    const fixed = build.pages.filter((p) => p.pass && p.attempts > 0).length;
    return [
      failing ? `${failing} page${failing > 1 ? "s" : ""} need review` : "Every page passed",
      fixed ? `${fixed} fixed automatically` : "",
      build.linkCheck.pass ? "" : "broken links found",
    ].filter(Boolean).join(" · ");
  });

  await doStep(build, "package", async () => {
    await packageSite(build);
    return "site.zip ready";
  });

  const ok = build.pages.every((p) => p.pass) && build.linkCheck?.pass !== false;
  build.status = ok ? "ready" : "needs_review";
  saveBuild(build);
  addEvent({ leadId: build.leadId, kind: ok ? "ready" : "review", title: ok ? "Website build ready" : "Website build needs review", detail: `${build.business}: ${build.pages.length} pages` });
}

/** Re-write one page from a change request, then re-check it and repackage. */
export async function revisePage(id: string, slug: string) {
  const build = getBuild(id);
  if (!build) return;
  const page = build.pages.find((p) => p.slug === slug);
  if (!page || !page.pendingChanges) return;
  build.status = "running";
  page.status = "running";
  saveBuild(build);
  const ctx = loadCtx(build);
  const layout = JSON.parse(readFileSync(layoutPath(id), "utf8")) as Layout;
  const current = JSON.parse(readFileSync(pagePartPath(id, slug), "utf8"));
  try {
    await writePage(ctx, layout, page, { current, changes: page.pendingChanges });
  } catch (e) {
    page.status = "done";
    throw e;
  }
  page.pendingChanges = undefined;
  page.status = "done";
  page.updatedAt = new Date().toISOString();
  writeSiteFiles(build, layout);
  await checkPage(ctx, page);
  build.linkCheck = await checkLinks(build);
  await packageSite(build);
  build.status = build.pages.every((p) => p.pass) && build.linkCheck.pass ? "ready" : "needs_review";
  saveBuild(build);
}
