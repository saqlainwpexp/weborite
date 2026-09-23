import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { BRAND_DIR, getSettings } from "../db.ts";
import type { CareHealth, CareIntel, CareRun, CareSite, CareStatus, PerfResult } from "../../shared/types.ts";
import { newContext } from "../pipeline/browser.ts";
import { readResult } from "../seo/store.ts";
import { careDir, readCare } from "./store.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const day = (iso?: string | number) => (iso ? new Date(typeof iso === "number" ? iso * 1000 : iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "–");

/** The monthly report you send the client: what was done, what it protects against, and how the site is doing. */
export function reportHtml(site: CareSite, run: CareRun | null) {
  const s = getSettings();
  const status = readCare<CareStatus>(site.id, "status");
  const intel = readCare<CareIntel>(site.id, "intel");
  const health = readCare<CareHealth>(site.id, "health");
  const perf = site.seoSiteId ? readResult<PerfResult>(site.seoSiteId, "perf") : null;
  const logoPath = s.logoFile ? join(BRAND_DIR, s.logoFile) : "";
  const logo = logoPath && existsSync(logoPath)
    ? `<img src="data:${extname(logoPath) === ".svg" ? "image/svg+xml" : `image/${extname(logoPath).slice(1).replace("jpg", "jpeg")}`};base64,${readFileSync(logoPath).toString("base64")}" alt="">`
    : "";
  const month = run ? new Date(run.startedAt).toLocaleDateString("en-GB", { month: "long", year: "numeric" }) : new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const applied = run?.items.filter((i) => i.live?.ok) ?? [];
  const skipped = run?.items.filter((i) => i.selected && !i.live?.ok) ?? [];
  const security = applied.filter((i) => i.security).length;
  const avg = perf?.pages.length ? Math.round(perf.pages.reduce((a, p) => a + (p.mobile?.score ?? 0), 0) / perf.pages.length) : null;
  const openVulns = intel?.vulns ?? [];
  const brand = s.brandColor || "#a36566";

  const row = (label: string, value: string) => `<tr><th>${esc(label)}</th><td>${value}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(site.name)} · ${esc(month)}</title>
<style>
@page { size: A4; margin: 18mm 16mm; }
* { box-sizing: border-box; }
body { font: 10.5pt/1.5 Inter, "Segoe UI", system-ui, sans-serif; color: #1c1b1b; margin: 0; }
header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid ${brand}; padding-bottom: 12px; }
header img { max-height: 40px; max-width: 180px; }
header .studio { font-weight: 600; font-size: 13pt; }
h1 { font-size: 22pt; font-weight: 500; letter-spacing: -.02em; margin: 22px 0 2px; }
.sub { color: #777; margin: 0 0 20px; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 18px 0 24px; }
.kpi { border: 1px solid #e8e5e5; border-radius: 10px; padding: 12px; }
.kpi b { display: block; font-size: 18pt; font-weight: 500; color: ${brand}; }
.kpi span { color: #777; font-size: 9pt; }
h2 { font-size: 12.5pt; font-weight: 600; margin: 22px 0 8px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
th { font-weight: 500; color: #555; width: 38%; }
.list td:first-child { width: 46%; }
.tag { display: inline-block; padding: 1px 7px; border-radius: 6px; font-size: 8.5pt; background: #f1eeee; }
.tag.sec { background: #fdecec; color: #9b3434; }
.ok { color: #25683f; } .warn { color: #86591a; } .bad { color: #9b3434; }
footer { margin-top: 28px; color: #999; font-size: 8.5pt; border-top: 1px solid #eee; padding-top: 8px; }
</style></head><body>
<header><div>${logo || `<span class="studio">${esc(s.studioName)}</span>`}</div><div style="text-align:right;color:#777">Website care report<br>${esc(month)}</div></header>
<h1>${esc(site.name)}</h1>
<p class="sub">${esc(site.siteUrl.replace(/^https?:\/\//, ""))}${site.client ? ` · prepared for ${esc(site.client)}` : ""}</p>

<div class="kpis">
  <div class="kpi"><b>${applied.length}</b><span>updates applied</span></div>
  <div class="kpi"><b>${security}</b><span>security fixes</span></div>
  <div class="kpi"><b>${health?.uptime.days30 !== null && health?.uptime.days30 !== undefined ? `${health.uptime.days30}%` : "–"}</b><span>uptime (30 days)</span></div>
  <div class="kpi"><b>${avg ?? "–"}</b><span>mobile speed score</span></div>
</div>

<h2>What we did</h2>
<table class="list">
${applied.map((i) => `<tr><td>${esc(i.name)} ${i.security ? '<span class="tag sec">security</span>' : ""}</td><td>${i.kind === "translations" ? "Updated" : `${esc(i.from)} → ${esc(i.to)}`}</td></tr>`).join("") || '<tr><td colspan="2">Everything was already up to date.</td></tr>'}
</table>
${run ? `<p>Every update was installed and tested on a private copy of the site first (same server, same PHP and WordPress versions): pages compared screen by screen, forms submitted, and the error log checked. Only updates that passed were applied to the live site${run.backup?.ok ? `, after a fresh backup (${esc(run.backup.plugin)}, ${day(run.backup.at)})` : ""}.</p>` : ""}
${skipped.length ? `<p class="warn">Held back for review: ${skipped.map((i) => `${esc(i.name)} (${esc(i.staging?.note || i.blocked || "")})`).join("; ")}.</p>` : ""}

<h2>Site health</h2>
<table>
${row("WordPress", esc(status?.core.version ?? "–"))}
${row("PHP", `${esc(status?.env.php ?? "–")} ${intel?.php.status === "eol" ? '<span class="bad">· no longer supported, upgrade recommended</span>' : intel?.php.status === "security" ? '<span class="warn">· security fixes only</span>' : '<span class="ok">· supported</span>'}`)}
${row("SSL certificate", health?.ssl ? `<span class="${health.ssl.daysLeft < 14 ? "bad" : "ok"}">Valid until ${day(health.ssl.validTo)}</span>` : "–")}
${row("Domain renewal", health?.domain ? `<span class="${health.domain.daysLeft < 30 ? "warn" : "ok"}">${day(health.domain.expires)}</span>` : "–")}
${row("Last backup", status?.backup.last ? day(status.backup.last) : esc(status?.backup.plugins.join(", ") || "–"))}
${row("Known vulnerabilities remaining", openVulns.length ? `<span class="bad">${openVulns.length}</span> (${Object.entries(openVulns.reduce<Record<string, number>>((a, v) => ((a[v.name] = (a[v.name] ?? 0) + 1), a), {})).map(([n, c]) => `${esc(n)} ${c}`).join(", ")})` : '<span class="ok">None</span>')}
${row("Security checks", status ? `${status.security.filter((c) => c.status === "ok").length} of ${status.security.length} passing` : "–")}
</table>

<footer>${esc(s.studioName)}${s.userEmail ? ` · ${esc(s.userEmail)}` : ""}${s.userPhone ? ` · ${esc(s.userPhone)}` : ""} · generated ${day(new Date().toISOString())}</footer>
</body></html>`;
}

export async function reportPdf(site: CareSite, run: CareRun | null) {
  const out = join(careDir(site.id), `report-${run?.id ?? "latest"}.pdf`);
  const ctx = await newContext({});
  try {
    const page = await ctx.newPage();
    await page.setContent(reportHtml(site, run), { waitUntil: "load" });
    await page.pdf({ path: out, format: "A4", printBackground: true });
  } finally {
    await ctx.close();
  }
  return out;
}
