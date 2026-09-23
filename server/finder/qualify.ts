import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../db.ts";
import { hideOverlays, newContext, UA_DESKTOP, UA_MOBILE } from "../pipeline/browser.ts";
import { extractJson, runClaude } from "../claude/runner.ts";
import type { FitGrade, Prospect, ProspectAudit, ProspectFit } from "../../shared/types.ts";
import { getProspect, saveProspect } from "./store.ts";

/**
 * Lead qualification: is this business a good prospect for a new website?
 * No website, a broken one, or an old/unprofessional one = good fit. A modern, solid site = poor fit.
 * Search ranking isn't checked (Google blocks automated searches); site quality stands in for it.
 */

export const SHOT_DIR = join(DATA, "finder", "shots");
export const shotPath = (id: string) => join(SHOT_DIR, `${id}.jpg`);

const NOT_A_SITE: [RegExp, string][] = [
  [/(^|\.)facebook\.com$|(^|\.)fb\.com$/, "Facebook page"],
  [/(^|\.)instagram\.com$/, "Instagram profile"],
  [/(^|\.)linktr\.ee$|(^|\.)linkin\.bio$/, "Linktree page"],
  [/(^|\.)business\.site$|(^|\.)g\.page$/, "Google Business mini-site"],
  [/\.wixsite\.com$/, "free Wix site"],
  [/\.wordpress\.com$/, "free WordPress.com site"],
  [/\.blogspot\.[a-z.]+$/, "Blogspot blog"],
  [/\.weebly\.com$/, "free Weebly site"],
  [/(^|\.)sites\.google\.com$/, "Google Sites page"],
  [/\.godaddysites\.com$/, "free GoDaddy site"],
  [/\.square\.site$/, "free Square site"],
  [/(^|\.)yelp\.[a-z.]+$|(^|\.)tripadvisor\.[a-z.]+$/, "directory listing"],
];

// Firewalls and bot checks (Cloudflare, Sucuri, Imperva…). These are not broken sites; they just can't be audited.
const BOT_CHECK = /just a moment|verify(ing)? you are (a )?human|checking your browser|attention required|access denied|request unsuccessful|incapsula|sucuri|ddos protection|captcha|are you a robot|security check|cf-chl|please enable cookies/i;
const PLACEHOLDER = /this domain (is|may be) for sale|domain (is )?parked|buy this domain|coming soon|under construction|account (has been )?suspended|website (is )?expired|default web page|it works!|index of \/|hello world!|future home of|site is currently unavailable/i;

function emptyAudit(url: string): ProspectAudit {
  return {
    url, finalUrl: url, reachable: false, status: 0, error: "", placeholder: "", blocked: false, https: url.startsWith("https://"), sslError: false, socialOnly: "", builder: "",
    loadMs: null, bytes: null, requests: null,
    mobile: { viewport: true, overflow: false, smallText: 0 },
    seo: { title: "", description: "", h1: 0, images: 0, missingAlt: 0, og: false, schema: [], lang: true },
    contact: { tel: false, form: false, whatsapp: false, email: false },
    copyrightYear: null, oldTech: [], words: 0, shot: false,
  };
}

/** Node's fetch validates certificates; a browser that ignores them still shows the page. */
async function certProblem(url: string) {
  if (!url.startsWith("https://")) return false;
  try {
    await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(12000) });
    return false;
  } catch (e) {
    return /CERT|SSL|TLS|self.signed|UNABLE_TO_VERIFY|altnames/i.test(`${(e as Error).message} ${String((e as { cause?: { code?: string; message?: string } }).cause?.code ?? "")} ${String((e as { cause?: { message?: string } }).cause?.message ?? "")}`);
  }
}

export async function auditWebsite(id: string, website: string): Promise<ProspectAudit> {
  let url = website.trim();
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  const a = emptyAudit(url);
  const hostname = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } })();
  const social = NOT_A_SITE.find(([re]) => re.test(hostname));
  if (social) {
    a.socialOnly = social[1];
    a.reachable = true;
    return a;
  }

  a.sslError = await certProblem(url);
  const ctx = await newContext({ viewport: { width: 390, height: 844 }, userAgent: UA_MOBILE, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true });
  try {
    const page = await ctx.newPage();
    let bytes = 0;
    let requests = 0;
    page.on("requestfinished", (r) => {
      requests++;
      void r.sizes().then((s) => (bytes += s.responseBodySize + s.responseHeadersSize)).catch(() => {});
    });
    const t0 = Date.now();
    let res = null;
    try {
      res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 });
      await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0];
      a.error = /ERR_NAME_NOT_RESOLVED/.test(msg) ? "The domain doesn't exist any more" : /TIMED_OUT|Timeout/i.test(msg) ? "The site didn't load within 35 seconds" : /CONNECTION_REFUSED|CONNECTION_RESET|EMPTY_RESPONSE/.test(msg) ? "The server refused the connection" : msg.replace(/^page\.goto: /, "").slice(0, 140);
      return a;
    }
    a.status = res?.status() ?? 0;
    const bodyText = async () => (await page.evaluate(() => `${document.title} ${document.body?.innerText.slice(0, 2000) ?? ""}`).catch(() => ""));
    // Challenge pages are short; a normal site that merely mentions reCAPTCHA in its footer isn't one.
    const challenge = async () => {
      const t = await bodyText();
      return t.split(/\s+/).length < 200 && BOT_CHECK.test(t);
    };
    // A bot check: give it a few seconds in case it clears by itself (never try to get past it).
    if ([401, 403, 429, 503].includes(a.status) || (await challenge())) {
      await page.waitForTimeout(8000);
      if ((await challenge()) || [401, 403, 429].includes(a.status)) {
        a.blocked = true;
        a.reachable = true;
        a.error = "The site blocks automated visits (firewall or bot check), so it couldn't be audited";
        return a;
      }
    }
    a.finalUrl = page.url();
    a.https = a.finalUrl.startsWith("https://");
    a.reachable = a.status > 0 && a.status < 400;
    if (!a.reachable) {
      a.error = `The site returns an error (HTTP ${a.status})`;
      return a;
    }
    // Time until the main content shows on a phone (Largest Contentful Paint), like Google's Core Web Vitals.
    const lcp = await page.evaluate(() => new Promise<number | null>((resolve) => {
      try {
        new PerformanceObserver((l) => resolve(l.getEntries().at(-1)?.startTime ?? null)).observe({ type: "largest-contentful-paint", buffered: true });
      } catch {
        resolve(null);
      }
      setTimeout(() => resolve(null), 1500);
    })).catch(() => null);
    const dcl = await page.evaluate(() => (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.domContentLoadedEventEnd ?? null).catch(() => null);
    a.loadMs = Math.round(lcp ?? dcl ?? Date.now() - t0);
    await page.waitForTimeout(1500);
    const d = await page.evaluate(() => {
      const text = document.body?.innerText ?? "";
      const html = document.documentElement.outerHTML;
      const years = [...text.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map((m) => Number(m[1])).filter((y) => y > 1995 && y < 2100);
      const els = Array.from(document.querySelectorAll<HTMLElement>("p, li, a, span, td"));
      const visible = els.filter((e) => e.offsetParent && (e.textContent ?? "").trim().length > 3).slice(0, 400);
      const small = visible.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12).length;
      const imgs = Array.from(document.images);
      const schema = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).flatMap((s) => {
        try {
          const j = JSON.parse(s.textContent ?? "");
          const list = Array.isArray(j) ? j : j["@graph"] ?? [j];
          return list.map((x: { "@type"?: string | string[] }) => [x["@type"]].flat().join("/")).filter(Boolean);
        } catch {
          return [];
        }
      });
      const gen = document.querySelector('meta[name="generator"]')?.getAttribute("content") ?? "";
      const builder = /wix/i.test(gen) || /static\.wixstatic/.test(html) ? "Wix" : /squarespace/i.test(gen + html.slice(0, 20000)) ? "Squarespace" : /webflow/i.test(gen) ? "Webflow" : /shopify/i.test(html.slice(0, 30000)) ? "Shopify" : /wordpress/i.test(gen) || /wp-content\//.test(html) ? "WordPress" : /godaddy|websitebuilder/i.test(gen) ? "GoDaddy builder" : gen.split(" ")[0] ?? "";
      const old: string[] = [];
      if (document.querySelector('embed[src$=".swf"], object[data$=".swf"]')) old.push("Flash");
      if (document.querySelector("font, center, marquee, frameset, frame")) old.push("1990s HTML tags");
      if (document.querySelectorAll("table table").length > 0 && document.querySelectorAll("div").length < 30) old.push("table-based layout");
      const jq = (window as unknown as { jQuery?: { fn?: { jquery?: string } } }).jQuery?.fn?.jquery ?? "";
      if (jq && Number(jq.split(".")[0]) < 2) old.push(`jQuery ${jq}`);
      return {
        viewport: Boolean(document.querySelector('meta[name="viewport"][content*="width"]')),
        overflow: document.documentElement.scrollWidth > window.innerWidth + 8,
        smallText: visible.length ? Math.round((small / visible.length) * 100) : 0,
        title: document.title.trim(),
        description: document.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() ?? "",
        h1: document.querySelectorAll("h1").length,
        images: imgs.length,
        missingAlt: imgs.filter((i) => !(i.getAttribute("alt") ?? "").trim()).length,
        og: Boolean(document.querySelector('meta[property="og:title"]')),
        schema,
        lang: Boolean(document.documentElement.lang),
        tel: Boolean(document.querySelector('a[href^="tel:"]')),
        form: Boolean(document.querySelector("form input[type=email], form textarea, form[action*=contact], .wpcf7, .elementor-form, .gform_wrapper, .wpforms-form")),
        whatsapp: /wa\.me\/|api\.whatsapp\.com/.test(html),
        email: Boolean(document.querySelector('a[href^="mailto:"]')),
        year: years.length ? Math.max(...years) : null,
        old,
        builder,
        words: text.split(/\s+/).filter(Boolean).length,
        placeholder: text.slice(0, 3000),
      };
    });
    a.mobile = { viewport: d.viewport, overflow: d.overflow, smallText: d.smallText };
    a.seo = { title: d.title, description: d.description, h1: d.h1, images: d.images, missingAlt: d.missingAlt, og: d.og, schema: d.schema, lang: d.lang };
    a.contact = { tel: d.tel, form: d.form, whatsapp: d.whatsapp, email: d.email };
    a.copyrightYear = d.year;
    a.oldTech = d.old;
    a.builder = d.builder;
    a.words = d.words;
    const ph = d.placeholder.match(PLACEHOLDER);
    if (ph && d.words < 400) a.placeholder = ph[0];
    await page.waitForTimeout(800);
    a.bytes = bytes || null;
    a.requests = requests || null;
  } finally {
    await ctx.close();
  }

  // What a visitor on a laptop sees first, for the design review.
  const desk = await newContext({ viewport: { width: 1366, height: 850 }, userAgent: UA_DESKTOP, ignoreHTTPSErrors: true });
  try {
    const page = await desk.newPage();
    await page.goto(a.finalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2500);
    await hideOverlays(page);
    mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: shotPath(id), type: "jpeg", quality: 60 });
    a.shot = true;
  } catch {
    /* no screenshot: scored without the design review */
  } finally {
    await desk.close();
  }
  return a;
}

/** Claude rates how professional each homepage looks (1–10), several screenshots per call. */
async function reviewDesigns(items: { id: string; name: string }[]) {
  const out = new Map<string, { score: number; note: string }>();
  for (let i = 0; i < items.length; i += 6) {
    const batch = items.slice(i, i + 6);
    try {
      const res = await runClaude({
        leadId: `finder-${batch[0].id}`,
        task: "qualify",
        cwd: SHOT_DIR,
        images: batch.map((b) => shotPath(b.id)),
        system: "You are a senior web designer judging small-business websites for a web agency deciding who to pitch. Be honest and specific.",
        prompt: `The ${batch.length} images are the top of these businesses' homepages, in this order:
${batch.map((b, n) => `${n + 1}. id=${b.id} · ${b.name}`).join("\n")}

For each, rate how professional and modern the design looks from 1 to 10:
If an image shows a security check, CAPTCHA, cookie wall, error page or a blank page instead of the website, return design 0 for it.
1–3 = dated, broken or amateur (old layout, clashing colours, stretched images, clip-art, walls of text, obvious template defaults)
4–6 = acceptable but plain or visibly aging
7–8 = modern and competent
9–10 = agency-quality, polished

Return only JSON:
\`\`\`json
[{"id":"…","design":1-10,"note":"one short sentence on the biggest visual strength or problem"}]
\`\`\``,
      });
      for (const r of extractJson<{ id: string; design: number; note: string }[]>(res.text)) {
        const d = Math.round(Number(r.design));
        if (batch.some((b) => b.id === r.id) && d >= 1 && d <= 10) out.set(r.id, { score: d, note: String(r.note ?? "").slice(0, 160) });
      }
    } catch {
      /* Claude unavailable: those prospects are scored on the technical checks alone */
    }
  }
  return out;
}

const gradeOf = (s: number): FitGrade => (s >= 65 ? "hot" : s >= 40 ? "warm" : "cold");
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function scoreProspect(p: Prospect, a: ProspectAudit | null, design: { score: number; note: string } | null): Omit<ProspectFit, "status" | "at"> {
  const reasons: { text: string; points: number }[] = [];
  const add = (points: number, text: string) => reasons.push({ points, text });
  let base: number;

  if (!p.website || !a) {
    base = 85;
    add(0, "No website: pitch a new one");
  } else if (a.socialOnly) {
    base = 82;
    add(0, `Only a ${a.socialOnly}, no real website`);
  } else if (a.blocked) {
    base = 30;
    add(0, "Couldn't audit: the site blocks automated visits (usually a firewall on a well-run site). Check it by hand");
  } else if (!a.reachable) {
    base = 90;
    add(0, `Website is broken: ${a.error || "it doesn't load"}`);
  } else if (a.placeholder) {
    base = 88;
    add(0, `Website is a placeholder ("${a.placeholder}")`);
  } else {
    base = 22;
    if (a.sslError) add(15, "Browsers show a security warning (bad SSL certificate)");
    else if (!a.https) add(12, "No HTTPS: browsers mark it “Not secure”");
    if (!a.mobile.viewport) add(15, "Not built for phones (no mobile layout)");
    else if (a.mobile.overflow) add(10, "Page scrolls sideways on phones");
    if (a.mobile.smallText > 30) add(4, `Text too small on phones (${a.mobile.smallText}% of text)`);
    if (a.loadMs !== null && a.loadMs > 4000) add(12, `Very slow on phones: main content shows after ${secs(a.loadMs)}`);
    else if (a.loadMs !== null && a.loadMs > 2500) add(6, `Slow on phones: main content shows after ${secs(a.loadMs)}`);
    if (a.bytes && a.bytes > 6_000_000) add(5, `Heavy page (${(a.bytes / 1_048_576).toFixed(1)} MB)`);
    const yearsOld = a.copyrightYear ? new Date().getFullYear() - a.copyrightYear : 0;
    if (yearsOld >= 3) add(10, `Footer says © ${a.copyrightYear}: likely not updated in ${yearsOld} years`);
    if (a.oldTech.length) add(Math.min(12, a.oldTech.length * 5), `Outdated tech: ${a.oldTech.join(", ")}`);
    if (a.words < 150) add(5, `Very little content (${a.words} words)`);
    if (!a.seo.title) add(5, "No page title");
    if (!a.seo.description) add(4, "No meta description (weak Google snippet)");
    if (!a.seo.h1) add(3, "No main heading (H1)");
    if (a.seo.images >= 4 && a.seo.missingAlt / a.seo.images > 0.5) add(3, `${a.seo.missingAlt} of ${a.seo.images} images have no alt text`);
    if (!a.seo.schema.some((t) => /LocalBusiness|Organization|Restaurant|Store|Service|Dentist|Physician|Attorney|Plumber|Contractor/i.test(t))) add(3, "No business schema for Google");
    if (!a.contact.tel && !a.contact.form) add(6, "No click-to-call or contact form");
    if (design) {
      const pts = (6 - design.score) * 6;
      if (pts > 0) add(pts, `Design looks dated (${design.score}/10): ${design.note}`);
      else if (pts < 0) add(pts, `Design already looks professional (${design.score}/10): ${design.note}`);
      else add(0, `Design is acceptable (${design.score}/10): ${design.note}`);
    }
    const technicallySound = a.https && !a.sslError && a.mobile.viewport && !a.mobile.overflow && (a.loadMs ?? 0) <= 2500;
    if (technicallySound && (design?.score ?? 0) >= 7) add(-10, "Modern, fast, mobile-friendly site: a harder sell");
  }
  if ((p.reviews ?? 0) >= 50 && (p.rating ?? 0) >= 4) add(3, `Established business (${p.reviews} reviews): can likely afford a site`);
  else if ((p.reviews ?? 0) === 0 && p.website === "") add(-5, "No reviews on Maps: may be inactive");

  const score = Math.max(3, Math.min(99, Math.round(base + reasons.reduce((s, r) => s + r.points, 0))));
  const top = [...reasons].filter((r) => r.points >= 0).sort((x, y) => y.points - x.points).slice(0, 2).map((r) => r.text.split(":")[0]);
  const summary = score >= 65 ? `Strong fit: ${top.join(" · ")}` : score >= 40 ? `Possible fit: ${top.join(" · ") || "some issues"}` : "Weak fit: their current site is in decent shape";
  return { score, grade: gradeOf(score), summary, reasons: reasons.sort((x, y) => y.points - x.points), design, audit: a };
}

/** Audit, review and score a list of prospects (two sites at a time). */
export async function qualifyProspects(ids: string[], onProgress?: (done: number, total: number) => void) {
  const now = () => new Date().toISOString();
  for (const id of ids) {
    const p = getProspect(id);
    if (p) {
      p.fit = { ...(p.fit ?? { score: 0, grade: "cold", summary: "", reasons: [], design: null, audit: null }), status: "pending", at: now() };
      saveProspect(p);
    }
  }
  const audits = new Map<string, ProspectAudit | null>();
  let done = 0;
  for (let i = 0; i < ids.length; i += 2) {
    await Promise.all(ids.slice(i, i + 2).map(async (id) => {
      const p = getProspect(id);
      if (!p) return;
      p.fit = { ...p.fit!, status: "running" };
      saveProspect(p);
      try {
        audits.set(id, p.website ? await auditWebsite(id, p.website) : null);
      } catch (e) {
        const q = getProspect(id);
        if (q) {
          q.fit = { ...q.fit!, status: "failed", note: (e as Error).message.slice(0, 160), at: now() };
          saveProspect(q);
        }
      }
      onProgress?.(++done, ids.length);
    }));
  }
  const toReview = [...audits.entries()].filter(([, a]) => a?.shot && a.reachable && !a.placeholder && !a.blocked).map(([id]) => ({ id, name: getProspect(id)?.name ?? "" }));
  const designs = toReview.length ? await reviewDesigns(toReview) : new Map();
  for (const [id, a] of audits) {
    const p = getProspect(id);
    if (!p) continue;
    p.fit = { ...scoreProspect(p, a, designs.get(id) ?? null), status: "done", at: now(), note: a?.shot && !designs.has(id) && a.reachable ? "Design review unavailable: scored on technical checks" : undefined };
    saveProspect(p);
  }
}

/** One qualification job at a time; button presses queue behind a running search. */
let chain: Promise<void> = Promise.resolve();
export function queueQualify(ids: string[]) {
  for (const id of ids) {
    const p = getProspect(id);
    if (p) {
      p.fit = { ...(p.fit ?? { score: 0, grade: "cold", summary: "", reasons: [], design: null, audit: null }), status: "pending", at: new Date().toISOString() };
      saveProspect(p);
    }
  }
  chain = chain.then(() => qualifyProspects(ids)).catch((e) => console.error("[qualify]", e));
  return chain;
}
