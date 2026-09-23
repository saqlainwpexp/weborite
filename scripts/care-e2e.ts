/**
 * End-to-end test of the maintenance pipeline against a mock WordPress that speaks the connector's API.
 * One update ("Breaker") takes the site down, so the rollback path is exercised too.
 *   npx tsx scripts/care-e2e.ts
 * Nothing touches a real site; the temporary records are removed at the end.
 */
import { createServer } from "node:http";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { careDir, createCareSite, deleteCareRow, getCareSite, updateCareSite } from "../server/care/store.ts";
import { continueRun, newRun } from "../server/care/pipeline.ts";
import { reportPdf } from "../server/care/report.ts";

const PORT = 4455;
const ORIGIN = `http://localhost:${PORT}`;
const STG = "/studio-staging-abc123";
const TOKEN = "tok123";

type Side = { plugins: Record<string, { name: string; version: string; next: string }>; theme: { version: string; next: string }; broken: boolean; mail: { at: number; to: string; subject: string; body: string }[]; snapshots: Record<string, string> };
const mk = (): Side => ({
  plugins: {
    "elementor/elementor.php": { name: "Elementor", version: "3.18.1", next: "4.3.0" },
    "breaker/breaker.php": { name: "Breaker", version: "1.0.0", next: "1.1.0" },
    "contact-form-7/wp-contact-form-7.php": { name: "Contact Form 7", version: "6.0", next: "" },
  },
  theme: { version: "3.0.0", next: "3.1.0" },
  broken: false,
  mail: [],
  snapshots: {},
});
const live = mk();
const staging = mk();
let stagingPhase = "none";
let backupStarted = 0;
const calls: string[] = [];

function status(side: Side, isStaging: boolean) {
  const env = { wp: "6.8.1", php: "8.3.30", db: "10.11.10-MariaDB", server: "LiteSpeed", sapi: "litespeed", extensions: ["curl", "gd", "mysqli"], memory_limit: "512M", wp_memory: "256M", max_exec: "300", upload_max: "128M", locale: "en_GB", multisite: false, https: false, fs_method: "direct", disk_free: 5e10, object_cache: false, debug: false, cron: true };
  return {
    at: Math.floor(Date.now() / 1000), staging: isStaging, home: ORIGIN + (isStaging ? STG : ""), env,
    core: { version: "6.8.1", update: "", locale: "en_GB" },
    plugins: Object.entries(side.plugins).map(([file, p]) => ({ file, slug: file.split("/")[0], name: p.name, version: p.version, active: true, update: p.next && p.next !== p.version ? p.next : "", package: true, requires_php: "", tested: "", wporg: true, auto_update: false })),
    themes: [{ stylesheet: "hello-elementor", name: "Hello Elementor", version: side.theme.version, active: true, parent: false, update: side.theme.next !== side.theme.version ? side.theme.next : "" }],
    translations: 0,
    security: [{ id: "file-edit", label: "Theme and plugin file editor disabled", status: "warn", detail: "" }],
    db: { size: 3e7, revisions: 120, auto_drafts: 3, trash: 1, spam_comments: 40, transients: 12, autoload: 8e5 },
    backup: { plugins: ["UpdraftPlus"], updraft: true, last: backupStarted, last_ok: true },
    staging_site: isStaging ? null : { status: stagingPhase, url: ORIGIN + STG, token: TOKEN },
    rollbacks: {}, paths: { abspath: "/x/", plugins: "/x/p", themes: "/x/t", content: "/x/c" }, paths_ok: true,
  };
}

function page(side: Side, path: string) {
  if (side.broken) return { code: 500, html: "<html><body><p>There has been a critical error on this website.</p></body></html>" };
  if (!["/", "/about/"].includes(path)) return { code: 404, html: "<html><body>Not found</body></html>" };
  const form = path === "/" ? `<form id="f"><label>Name <input name="your-name" required></label><label>Email <input type="email" name="your-email" required></label><label>Message <textarea name="msg"></textarea></label><button type="submit">Send</button></form><div class="out"></div>
<script>document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();await fetch(location.pathname.replace(/\\/$/,'')+'/mailhook',{method:'POST'});document.querySelector('.out').innerHTML='<div class="elementor-message">Thank you, your message was sent.</div>';});</script>` : "";
  return { code: 200, html: `<!doctype html><html lang="en"><head><title>Mock ${path}</title><style>body{font:16px sans-serif;margin:40px}header{background:#234;color:#fff;padding:30px}</style></head><body><header>Mock Bakery</header><nav><a href="/">Home</a> <a href="/about/">About</a></nav><main><h1>${path === "/" ? "Fresh cupcakes" : "About us"}</h1><p>Plugins: ${Object.values(side.plugins).map((p) => p.version).join(", ")}</p>${form}</main></body></html>` };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, ORIGIN);
  let path = url.pathname;
  const isStaging = path.startsWith(STG);
  if (isStaging) path = path.slice(STG.length) || "/";
  const side = isStaging ? staging : live;
  const body = await new Promise<string>((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
  const json = (o: unknown, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  const route = url.searchParams.get("rest_route") ?? (path.startsWith("/wp-json/") ? path.slice(8) : null);

  if (route) {
    calls.push(`${isStaging ? "staging" : "live"} ${req.method} ${route}`);
    if (req.headers.authorization !== "Basic " + Buffer.from("admin:secret").toString("base64")) return json({ message: "bad login" }, 401);
    const p = body ? JSON.parse(body) : {};
    if (route === "/studio/v1/ping") return json({ plugin: "1.0.9", elementor: "3.18.1", pro: false, widgets: [], seo: true, seo_plugin: "", care: 1 });
    if (route === "/studio/v1/care/status") return json(status(side, isStaging));
    if (route === "/studio/v1/care/staging") {
      if (p.action === "delete") { stagingPhase = "none"; return json({ status: "none" }); }
      if (p.action === "start") { stagingPhase = "files"; Object.assign(staging, mk()); return json({ status: "files", files: { done: 100, total: 900 } }); }
      stagingPhase = stagingPhase === "files" ? "tables" : "ready";
      return json({ status: stagingPhase, url: ORIGIN + STG, token: TOKEN, files: { done: 900, total: 900 }, tables: { done: 12, total: 12 }, ready_at: Math.floor(Date.now() / 1000) });
    }
    if (route === "/studio/v1/care/update") {
      if (p.type === "plugin") {
        const pl = side.plugins[p.id];
        side.snapshots[p.id] = pl.version;
        const from = pl.version;
        pl.version = pl.next;
        if (pl.name === "Breaker") side.broken = true;
        return json({ ok: true, from, to: pl.version, messages: [], errors: [] });
      }
      if (p.type === "theme") { const from = side.theme.version; side.theme.version = side.theme.next; return json({ ok: true, from, to: side.theme.version, messages: [], errors: [] }); }
      return json({ message: "unknown" }, 400);
    }
    if (route === "/studio/v1/care/rollback") {
      const pl = side.plugins[p.id];
      pl.version = side.snapshots[p.id];
      if (pl.name === "Breaker") side.broken = false;
      return json({ ok: true, version: pl.version });
    }
    if (route === "/studio/v1/care/errors") return json({ counts: { fatal: 0, warning: 2 }, fatal: [], files: 1 });
    if (route === "/studio/v1/care/mail") return json({ mail: side.mail.filter((m) => m.at >= Number(url.searchParams.get("since"))), blocked: [] });
    if (route === "/studio/v1/care/backup") {
      if (p.action === "start") { backupStarted = Math.floor(Date.now() / 1000); return json({ started: backupStarted }); }
      return json({ started: backupStarted, done: true, success: true, time: backupStarted + 5, errors: [] });
    }
    if (route === "/studio/v1/care/db-upgrade") return json({ ok: true, from: 1, to: 1 });
    return json({ code: "rest_no_route" }, 404);
  }
  if (path.endsWith("/mailhook")) { side.mail.push({ at: Math.floor(Date.now() / 1000), to: "owner@bakery.test", subject: "New enquiry", body: "…" }); return json({ ok: true }); }
  if (path === "/wp-cron.php" || path === "/robots.txt" || path.endsWith(".xml")) { res.writeHead(404); return res.end(); }
  if (isStaging && !(req.headers.cookie ?? "").includes(`studio_stg=${TOKEN}`)) { res.writeHead(403); return res.end("private"); }
  const out = page(side, path);
  res.writeHead(out.code, { "Content-Type": "text/html" });
  res.end(out.html);
});
await new Promise<void>((r) => server.listen(PORT, r));

const results: string[] = [];
const check = (label: string, cond: boolean, detail = "") => { results.push(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` · ${detail}` : ""}`); };
const site = createCareSite({ name: "Mock Bakery", siteUrl: ORIGIN, wpUser: "admin", appPassword: "secret", client: "Test client", seoSiteId: null });
try {
  updateCareSite(site.id, (s) => (s.run = newRun("manual")));
  const note = await continueRun(site.id, (n) => process.stdout.write(`  · ${n}\n`));
  let s = getCareSite(site.id)!;
  const r = s.run!;
  check("stops for approval", note === "Waiting for approval" && r.step === "approve" && r.status === "waiting", note);
  check("found 3 updates", r.items.length === 3, r.items.map((i) => `${i.name} ${i.from}→${i.to}`).join(", "));
  check("Elementor flagged as security fix", r.items.find((i) => i.name === "Elementor")?.security === true);
  const breaker = r.items.find((i) => i.name === "Breaker")!;
  check("Breaker failed on staging and was rolled back", breaker.staging?.ok === false && breaker.staging?.rolledBack === true, breaker.staging?.note);
  check("staging put back to 1.0.0 after the rollback", staging.plugins["breaker/breaker.php"].version === "1.0.0" && !staging.broken);
  check("Elementor + theme passed on staging", r.items.filter((i) => i.staging?.ok).length === 2);
  check("live untouched so far", live.plugins["elementor/elementor.php"].version === "3.18.1" && !calls.some((c) => c.startsWith("live POST /studio/v1/care/update")));
  check("staging verdict is review (Breaker held back)", r.staging?.verdict === "review", r.staging?.reasons.join(" | "));
  check("pages compared", (r.staging?.pages.length ?? 0) >= 3 && r.staging!.pages.every((p) => p.diff !== null), r.staging?.pages.map((p) => `${p.path} ${p.diff}%`).join(", "));
  check("form tested on staging before and after, email captured", r.staging?.forms.length === 1 && r.staging.forms[0].before === true && r.staging.forms[0].after === true && r.staging.forms[0].mail === true, JSON.stringify(r.staging?.forms[0]));
  check("environment matches", r.staging?.env?.matches === true);
  if (process.env.HOLD) {
    // Leave the site waiting for approval (and the mock running) so the dashboard can be inspected.
    console.log(`HOLDING site ${site.id} at approval; stop this process and delete the site when done.`);
    await new Promise(() => {});
  }

  // Approve what passed (what the approve route does).
  updateCareSite(site.id, (x) => {
    for (const i of x.run!.items) i.selected = Boolean(i.staging?.ok);
    x.run!.approvedAt = new Date().toISOString();
    x.run!.step = "backup";
    x.run!.status = "running";
  });
  const t0 = Date.now();
  const done = await continueRun(site.id, (n) => process.stdout.write(`  · ${n}\n`));
  s = getCareSite(site.id)!;
  check("finished", s.run!.status === "done" && s.run!.step === "done", `${done} in ${Math.round((Date.now() - t0) / 1000)}s`);
  check("backup ran before any live update", calls.indexOf("live POST /studio/v1/care/backup") < calls.indexOf("live POST /studio/v1/care/update"));
  check("Elementor + theme updated on live", live.plugins["elementor/elementor.php"].version === "4.3.0" && live.theme.version === "3.1.0");
  check("Breaker NOT applied to live", live.plugins["breaker/breaker.php"].version === "1.0.0" && !live.broken);
  check("live verdict pass", s.run!.live?.verdict === "pass", s.run!.live?.reasons.join(" | "));
  check("no live form submission", !calls.some((c) => c.startsWith("live") && c.includes("mail")));
  check("staging deleted afterwards", calls.includes("live POST /studio/v1/care/staging") && stagingPhase === "none");
  check("history recorded", s.history[0]?.updated === 2, s.history[0]?.note);
  const pdf = await reportPdf(s, s.run);
  check("client report PDF", existsSync(pdf), pdf);
  if (process.env.KEEP_PDF) copyFileSync(pdf, process.env.KEEP_PDF);
} catch (e) {
  check("pipeline threw", false, (e as Error).stack?.split("\n").slice(0, 4).join(" ← "));
} finally {
  deleteCareRow(site.id);
  rmSync(careDir(site.id), { recursive: true, force: true });
  server.close();
  console.log("\n" + results.join("\n"));
  process.exit(results.some((l) => l.startsWith("FAIL")) ? 1 : 0);
}
