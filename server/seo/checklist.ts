import { createHash } from "node:crypto";
import { getSettings } from "../db.ts";
import type { ChecklistItem, GoLiveRecord, OnPageResult, PerfResult, QaResult, SeoSite } from "../../shared/types.ts";
import { HUMAN_CHECKS } from "../golive/store.ts";
import { readResult, writeResult } from "./store.ts";

/** pass: null = measured but still waiting on you (e.g. forms not tested yet). */
type AutoRule = { id: string; group: string; label: string; eval: (r: { qa: QaResult | null; perf: PerfResult | null; onpage: OnPageResult | null; site: SeoSite }) => { pass: boolean | null; detail: string } | null };

const pct = (n: number, d: number) => (d ? `${n}/${d}` : "0");

/** Automated items. Returning null means "not measured yet". */
const RULES: AutoRule[] = [
  // Post-launch QA
  { id: "forms-tested", group: "Post-launch QA", label: "Every form submits successfully", eval: ({ qa }) => qa && (!qa.forms.length ? { pass: true, detail: "No forms on the site" }
    : qa.forms.some((f) => f.test?.ok === false) ? { pass: false, detail: `${qa.forms.filter((f) => f.test?.ok === false).length} form(s) failed the test` }
    : qa.forms.some((f) => !f.test || f.test.ok === null) ? { pass: null, detail: `${qa.forms.filter((f) => !f.test).length} not tested yet${qa.forms.some((f) => f.test?.ok === null) ? ", some need a manual check" : ""}` }
    : { pass: true, detail: `${qa.forms.length}/${qa.forms.length} forms confirmed working` }) },
  { id: "spelling", group: "Post-launch QA", label: "No spelling or grammar mistakes", eval: ({ qa }) => qa && { pass: qa.issues.length === 0, detail: qa.issues.length ? `${qa.issues.length} issues found` : "Clean" } },
  { id: "consistency", group: "Post-launch QA", label: "Phone, email, address and hours match on every page", eval: ({ qa }) => qa && { pass: !qa.consistency.some((c) => c.verdict === "inconsistent"), detail: qa.consistency.filter((c) => c.verdict === "inconsistent").map((c) => c.kind).join(", ") || "Consistent" } },
  { id: "links", group: "Post-launch QA", label: "No broken links", eval: ({ qa }) => qa && { pass: qa.links.length === 0, detail: qa.links.length ? `${qa.links.length} broken` : "All links resolve" } },
  // Performance
  { id: "lcp", group: "Performance", label: "LCP under 2.5s on mobile", eval: ({ perf }) => perf && (() => { const bad = perf.pages.filter((p) => p.mobile && p.mobile.lcp > 2500); return { pass: !bad.length, detail: bad.length ? `${bad.length} pages slower (worst ${(Math.max(...bad.map((p) => p.mobile!.lcp)) / 1000).toFixed(1)}s)` : "All pages pass" }; })() },
  { id: "cls", group: "Performance", label: "CLS under 0.1", eval: ({ perf }) => perf && (() => { const bad = perf.pages.filter((p) => p.mobile && p.mobile.cls > 0.1); return { pass: !bad.length, detail: bad.length ? `${bad.length} pages shift` : "Stable layouts" }; })() },
  { id: "tbt", group: "Performance", label: "Total blocking time under 200ms", eval: ({ perf }) => perf && (() => { const bad = perf.pages.filter((p) => p.mobile && p.mobile.tbt > 200); return { pass: !bad.length, detail: bad.length ? `${bad.length} pages block the main thread` : "Responsive" }; })() },
  { id: "score", group: "Performance", label: "Mobile performance score 90+", eval: ({ perf }) => perf && (() => { const bad = perf.pages.filter((p) => p.mobile && p.mobile.score < 90); return { pass: !bad.length, detail: bad.length ? `${bad.length} pages under 90` : "All 90+" }; })() },
  { id: "weight", group: "Performance", label: "Pages under 2 MB", eval: ({ perf }) => perf && (() => { const bad = perf.pages.filter((p) => p.mobile && p.mobile.weight > 2_000_000); return { pass: !bad.length, detail: bad.length ? `${bad.length} heavy pages` : "All light" }; })() },
  { id: "https", group: "Page experience", label: "HTTPS on every page", eval: ({ perf }) => perf && { pass: perf.pages.every((p) => p.experience.https), detail: pct(perf.pages.filter((p) => p.experience.https).length, perf.pages.length) } },
  { id: "mobile", group: "Page experience", label: "Mobile-friendly (no sideways scroll, working menu)", eval: ({ perf }) => perf && { pass: perf.pages.every((p) => !p.experience.mobileIssues.length), detail: perf.pages.filter((p) => p.experience.mobileIssues.length).length + " pages with issues" } },
  { id: "console", group: "Page experience", label: "No JavaScript errors in the console", eval: ({ perf }) => perf && { pass: perf.pages.every((p) => p.experience.consoleErrors === 0), detail: `${perf.pages.reduce((n, p) => n + p.experience.consoleErrors, 0)} errors` } },
  // On-page SEO
  { id: "titles", group: "On-page SEO", label: "Unique meta titles, 30–60 characters", eval: ({ onpage }) => onpage && (() => { const t = onpage.pages.map((p) => p.title); const bad = onpage.pages.filter((p) => p.title.length < 30 || p.title.length > 60 || t.indexOf(p.title) !== t.lastIndexOf(p.title)); return { pass: !bad.length, detail: bad.length ? `${bad.length} pages to fix` : "All good" }; })() },
  { id: "descriptions", group: "On-page SEO", label: "Unique meta descriptions, 70–160 characters", eval: ({ onpage }) => onpage && (() => { const bad = onpage.pages.filter((p) => p.description.length < 70 || p.description.length > 160); return { pass: !bad.length, detail: bad.length ? `${bad.length} pages to fix` : "All good" }; })() },
  { id: "h1", group: "On-page SEO", label: "Exactly one H1 per page", eval: ({ onpage }) => onpage && { pass: onpage.pages.every((p) => p.h1.length === 1), detail: `${onpage.pages.filter((p) => p.h1.length !== 1).length} pages off` } },
  { id: "alt", group: "On-page SEO", label: "Every image has alt text", eval: ({ onpage }) => onpage && { pass: onpage.images.every((i) => i.alt !== null), detail: `${onpage.images.filter((i) => i.alt === null).length} missing` } },
  { id: "webp", group: "On-page SEO", label: "Images served as WebP/AVIF", eval: ({ onpage }) => onpage && { pass: onpage.images.every((i) => ["webp", "avif", "svg"].includes(i.format) || i.webp?.status === "done"), detail: `${onpage.images.filter((i) => !["webp", "avif", "svg"].includes(i.format) && i.webp?.status !== "done").length} to convert` } },
  { id: "img-weight", group: "On-page SEO", label: "No image over 200 KB", eval: ({ onpage }) => onpage && { pass: onpage.images.every((i) => (i.webp?.after ?? i.bytes ?? 0) <= 200_000), detail: `${onpage.images.filter((i) => (i.webp?.after ?? i.bytes ?? 0) > 200_000).length} heavy images` } },
  { id: "schema", group: "On-page SEO", label: "Schema markup on every page", eval: ({ onpage }) => onpage && { pass: onpage.pages.every((p) => p.schemaTypes.length > 0 || p.schema?.applied), detail: `${onpage.pages.filter((p) => !p.schemaTypes.length && !p.schema?.applied).length} pages without` } },
  { id: "canonical", group: "On-page SEO", label: "Canonical tag on every page", eval: ({ onpage }) => onpage && { pass: onpage.pages.every((p) => p.canonical), detail: `${onpage.pages.filter((p) => !p.canonical).length} missing` } },
  { id: "noindex", group: "On-page SEO", label: "No live page is set to noindex", eval: ({ onpage }) => onpage && { pass: !onpage.pages.some((p) => /noindex/i.test(p.robots)), detail: onpage.pages.filter((p) => /noindex/i.test(p.robots)).map((p) => new URL(p.url).pathname).join(", ") || "Indexable" } },
  { id: "og", group: "On-page SEO", label: "Open Graph title, description and image", eval: ({ onpage }) => onpage && { pass: onpage.pages.every((p) => p.og.title && p.og.description && p.og.image), detail: `${onpage.pages.filter((p) => !(p.og.title && p.og.description && p.og.image)).length} pages incomplete` } },
  { id: "lang", group: "On-page SEO", label: "Language set on <html>", eval: ({ onpage }) => onpage && { pass: onpage.pages.every((p) => p.lang), detail: onpage.pages.every((p) => p.lang) ? onpage.pages[0]?.lang ?? "" : "Missing" } },
  // Technical
  { id: "sitemap", group: "Technical", label: "XML sitemap available", eval: ({ onpage }) => onpage && { pass: Boolean(onpage.site.sitemap), detail: onpage.site.sitemap || "Not found" } },
  { id: "robots", group: "Technical", label: "robots.txt present", eval: ({ onpage }) => onpage && { pass: onpage.site.robotsTxt, detail: onpage.site.robotsTxt ? "Found" : "Missing" } },
  { id: "redirect", group: "Technical", label: "http:// redirects to https://", eval: ({ onpage }) => onpage && { pass: onpage.site.httpsRedirect, detail: onpage.site.httpsRedirect ? "Redirects" : "No redirect" } },
  { id: "404", group: "Technical", label: "Missing pages return a real 404", eval: ({ onpage }) => onpage && { pass: onpage.site.notFoundStatus === 404, detail: `Returns ${onpage.site.notFoundStatus || "nothing"}` } },
  { id: "favicon", group: "Technical", label: "Favicon set", eval: ({ onpage }) => onpage && { pass: onpage.site.favicon, detail: onpage.site.favicon ? "Found" : "Missing" } },
];

const customId = (label: string) => "c-" + createHash("sha1").update(label).digest("hex").slice(0, 10);

export function buildChecklist(site: SeoSite): ChecklistItem[] {
  const ctx = { qa: readResult<QaResult>(site.id, "qa"), perf: readResult<PerfResult>(site.id, "perf"), onpage: readResult<OnPageResult>(site.id, "onpage"), site };
  const manual = readResult<Record<string, "done" | "todo">>(site.id, "checklist") ?? {};
  const items: ChecklistItem[] = RULES.map((r) => {
    const res = r.eval(ctx);
    const override = manual[r.id];
    return { id: r.id, label: r.label, group: r.group, auto: true, status: override === "done" ? "done" : res && res.pass !== null ? (res.pass ? "pass" : "fail") : "todo", detail: res?.detail ?? "Run the audit to check this" };
  });
  // Go-live: every measured check (info-only rows left out), then the checks only a person can judge.
  const golive = readResult<GoLiveRecord>(site.id, "golive");
  for (const c of golive?.checks ?? []) {
    if (c.status === "info") continue;
    const id = `g-${c.id}`;
    items.push({ id, label: c.label, group: `Go-live: ${c.group}`, auto: true, status: manual[id] === "done" ? "done" : c.status === "pass" ? "pass" : c.status === "fail" ? "fail" : "todo", detail: c.detail });
  }
  for (const h of HUMAN_CHECKS) {
    items.push({ id: `h-${h.id}`, label: h.label, group: "Go-live: people check", auto: false, status: golive?.human?.[h.id]?.done ? "done" : "todo", detail: h.hint });
  }
  for (const c of getSettings().seoChecklist) {
    const id = customId(c.label);
    items.push({ id, label: c.label, group: c.group || "Custom", auto: false, status: manual[id] === "done" ? "done" : "todo" });
  }
  return items;
}

export function setChecklistItem(siteId: string, itemId: string, status: "done" | "todo") {
  if (itemId.startsWith("h-")) {
    const rec = readResult<GoLiveRecord>(siteId, "golive");
    if (rec) {
      rec.human = { ...rec.human, [itemId.slice(2)]: { done: status === "done", at: new Date().toISOString(), note: rec.human?.[itemId.slice(2)]?.note ?? "" } };
      writeResult(siteId, "golive", rec);
      return;
    }
  }
  const manual = readResult<Record<string, "done" | "todo">>(siteId, "checklist") ?? {};
  if (status === "todo") delete manual[itemId];
  else manual[itemId] = status;
  writeResult(siteId, "checklist", manual);
}
