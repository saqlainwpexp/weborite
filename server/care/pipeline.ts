import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { addEvent, getSettings } from "../db.ts";
import type { CareFormCheck, CareIntel, CarePageCheck, CareRun, CareSite, CareStagingInfo, CareStatus, CareTestReport, CareUpdateItem, PerfResult, QaForm, QaResult } from "../../shared/types.ts";
import { ping, type WpAuth } from "../wp/client.ts";
import { discoverPages } from "../seo/crawl.ts";
import { scanPages, testForm } from "../seo/qa.ts";
import { getSite, readResult, saveSite } from "../seo/store.ts";
import { runSeoPhase } from "../seo/routes.ts";
import { careBackup, careDbUpgrade, careErrors, careMail, careRollback, careStaging, careStatus, careUpdate } from "./client.ts";
import { gatherHealth } from "./health.ts";
import { gatherIntel, updateFixesVuln } from "./intel.ts";
import { capturePages, compareEnv, comparePages, deactivated, onBase, smoke, stagingCookie } from "./tests.ts";
import { careDir, careSecret, getCareSite, readCare, updateCareSite, writeCare } from "./store.ts";

export type Progress = (note: string) => void;

export const careAuth = (s: CareSite): WpAuth => ({ siteUrl: s.siteUrl, user: s.wpUser, appPassword: careSecret(s.id) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
const runDir = (id: string, runId: string) => join(careDir(id), "runs", runId);

function log(id: string, text: string) {
  updateCareSite(id, (s) => {
    if (!s.run) return;
    s.run.log.push({ at: new Date().toISOString(), text });
    s.run.log = s.run.log.slice(-200);
  });
}

function setRun(id: string, fn: (r: CareRun) => void) {
  updateCareSite(id, (s) => s.run && fn(s.run));
}

/* ---------- scan: versions, updates, vulnerabilities, health ---------- */

export async function scanSite(id: string, progress: Progress) {
  const site = getCareSite(id)!;
  const auth = careAuth(site);
  progress("Connecting to the site…");
  let p: Awaited<ReturnType<typeof ping>>;
  try {
    p = await ping(auth);
  } catch (e) {
    updateCareSite(id, (s) => (s.connected = { ok: false, plugin: "", care: 0, checkedAt: new Date().toISOString(), error: (e as Error).message }));
    throw e;
  }
  if (!p.care) {
    const msg = "The Studio Connector on this site is too old for maintenance. Download it again from this page and upload it under Plugins → Add New → Upload.";
    updateCareSite(id, (s) => (s.connected = { ok: false, plugin: p.plugin, care: 0, checkedAt: new Date().toISOString(), error: msg }));
    throw new Error(msg);
  }
  progress("Checking versions and available updates…");
  const status = await careStatus(auth, true);
  if (status.staging) throw new Error("This address is a staging copy, not the live site.");
  writeCare(id, "status", status);
  progress("Looking up known vulnerabilities…");
  const intel = await gatherIntel(status);
  writeCare(id, "intel", intel);
  progress("Checking SSL, domain and uptime…");
  const health = await gatherHealth(id, site.siteUrl);
  writeCare(id, "health", health);
  const items = await pendingItems(status, intel);
  updateCareSite(id, (s) => {
    s.connected = { ok: true, plugin: p.plugin, care: p.care ?? 0, checkedAt: new Date().toISOString() };
    s.lastScan = new Date().toISOString();
    s.summary = {
      wp: status.core.version,
      php: status.env.php,
      updates: items.length,
      security: items.filter((i) => i.security).length,
      vulns: intel.vulns.length,
      critical: intel.vulns.filter((v) => v.severity === "critical" || v.severity === "high").length,
      warnings: status.security.filter((c) => c.status === "fail" || c.status === "warn").length + (health.dirListing ? 1 : 0),
      backup: status.backup.plugins.join(", "),
      lastBackup: status.backup.last,
    };
  });
  return `${items.length} update${items.length === 1 ? "" : "s"} available, ${intel.vulns.length} known vulnerabilit${intel.vulns.length === 1 ? "y" : "ies"}`;
}

export async function pendingItems(status: CareStatus, intel: CareIntel | null): Promise<CareUpdateItem[]> {
  const items: CareUpdateItem[] = [];
  const vulnFor = (slug: string) => intel?.vulns.some((v) => v.slug === slug) ?? false;
  if (status.core.update) {
    items.push({ kind: "core", id: "core", name: "WordPress", from: status.core.version, to: status.core.update, premium: false, selected: true,
      security: vulnFor("wordpress") && (await updateFixesVuln("core", "wordpress", status.core.version, status.core.update)) });
  }
  for (const p of status.plugins.filter((x) => x.update)) {
    const php = p.requires_php && compare(status.env.php, p.requires_php) < 0 ? `Needs PHP ${p.requires_php}; the site runs ${status.env.php}` : "";
    const blocked = !p.package ? "No download available. Premium plugins need an active licence on this site." : php;
    items.push({ kind: "plugin", id: p.file, name: p.name, from: p.version, to: p.update, premium: !p.wporg, selected: !blocked, blocked: blocked || undefined,
      security: vulnFor(p.slug) && (await updateFixesVuln("plugin", p.slug, p.version, p.update)) });
  }
  for (const t of status.themes.filter((x) => x.update)) {
    items.push({ kind: "theme", id: t.stylesheet, name: t.name + (t.active ? "" : " (inactive)"), from: t.version, to: t.update, premium: false, selected: true,
      security: vulnFor(t.stylesheet) && (await updateFixesVuln("theme", t.stylesheet, t.version, t.update)) });
  }
  if (status.translations) items.push({ kind: "translations", id: "translations", name: "Translations", from: `${status.translations} pending`, to: "latest", premium: false, selected: true, security: false });
  return items;
}

function compare(a: string, b: string) {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/* ---------- the maintenance run ---------- */

export function newRun(trigger: CareRun["trigger"]): CareRun {
  const d = new Date();
  return {
    id: d.toISOString().replace(/[-:T]/g, "").slice(0, 12),
    month: d.toISOString().slice(0, 7),
    trigger,
    startedAt: d.toISOString(),
    step: "scan",
    status: "running",
    note: "Starting",
    items: [],
    paths: [],
    log: [],
  };
}

/** Pages to test: home first, then the site's other pages, at most 10. */
async function testPaths(site: CareSite) {
  const seo = site.seoSiteId ? getSite(site.seoSiteId) : null;
  let urls = seo?.pages.map((p) => p.url) ?? [];
  if (!urls.length) {
    const found = await discoverPages(site.siteUrl, 20);
    urls = found.map((p) => p.url);
    if (seo && found.length) {
      seo.pages = found;
      saveSite(seo);
    }
  }
  const origin = new URL(site.siteUrl).origin;
  const paths = [...new Set(urls.filter((u) => u.startsWith(origin)).map((u) => new URL(u).pathname + new URL(u).search))];
  paths.sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : 0));
  if (!paths.includes("/")) paths.unshift("/");
  return paths.slice(0, 10);
}

/** Forms known from the Launch & SEO scan (or found now). Never submitted on live by maintenance. */
async function knownForms(site: CareSite): Promise<QaForm[]> {
  const qa = site.seoSiteId ? readResult<QaResult>(site.seoSiteId, "qa") : null;
  if (qa) return qa.forms.slice(0, 5);
  const seo = site.seoSiteId ? getSite(site.seoSiteId) : null;
  const urls = seo?.pages.map((p) => p.url).slice(0, 15) ?? [site.siteUrl + "/"];
  return (await scanPages(urls)).forms.slice(0, 5);
}

const stagingInfo = (id: string) => readCare<CareStagingInfo>(id, "staging");
const stgAuth = (site: CareSite, stg: CareStagingInfo): WpAuth => ({ ...careAuth(site), siteUrl: stg.url! });

async function testFormsOnStaging(site: CareSite, stg: CareStagingInfo, dir: string, tag: string) {
  const forms = await knownForms(site);
  const email = getSettings().qaEmail || getSettings().userEmail || "qa@example.com";
  const cookies = stagingCookie(stg.url!, stg.token!);
  const out: { page: string; index: number; name: string; ok: boolean | null; mail: boolean | null; detail: string }[] = [];
  for (const f of forms) {
    const since = nowSec() - 2;
    const r = await testForm(f, email, dir, { url: onBase(f.page, site.siteUrl, stg.url!), cookies, shotTag: `${tag}-` });
    const mail = await careMail(stgAuth(site, stg), since, stg.token!).then((m) => m.mail.length > 0).catch(() => null);
    out.push({ page: new URL(f.page).pathname, index: f.index, name: f.name, ok: r?.ok ?? null, mail, detail: r?.detail ?? "" });
  }
  return out;
}

export async function continueRun(id: string, progress: Progress): Promise<string> {
  for (;;) {
    const site = getCareSite(id)!;
    const run = site.run;
    if (!run) return "No run";
    if (run.status === "cancelled") return "Cancelled";
    const note = (text: string) => {
      progress(text);
      setRun(id, (r) => (r.note = text));
    };
    const next = (step: CareRun["step"]) => setRun(id, (r) => (r.step = step));

    switch (run.step) {
      case "scan": {
        note("Scanning the live site…");
        await scanSite(id, progress);
        const status = readCare<CareStatus>(id, "status")!;
        const items = await pendingItems(status, readCare<CareIntel>(id, "intel"));
        const paths = await testPaths(getCareSite(id)!);
        setRun(id, (r) => {
          r.items = items;
          r.paths = paths;
        });
        if (!items.some((i) => i.selected)) {
          finish(id, "pass", items.length ? "Updates need attention by hand (see the list); nothing could be applied automatically." : "Everything is already up to date.");
          return "Nothing to update";
        }
        log(id, `${items.filter((i) => i.selected).length} updates to test on staging`);
        next("clone");
        break;
      }

      case "clone": {
        const auth = careAuth(site);
        note("Creating a private staging copy on the same server…");
        let info = await careStaging(auth, "start");
        while (!["ready", "failed"].includes(info.status)) {
          note(info.status === "files" ? `Copying files to staging: ${info.files?.done ?? 0} of ${info.files?.total ?? "?"}` : info.status === "tables" ? `Copying database tables: ${info.tables?.done ?? 0} of ${info.tables?.total ?? "?"}` : `Staging: ${info.status}…`);
          info = await careStaging(auth, "continue");
        }
        if (info.status === "failed") throw new Error(`Staging clone failed: ${info.error}`);
        writeCare(id, "staging", info);
        const cookies = stagingCookie(info.url!, info.token!);
        const home = await smoke(info.url + "/", cookies);
        if (!home.ok) throw new Error(`The staging copy was created but doesn't load (HTTP ${home.status}${home.fatal ? ", PHP fatal error" : ""}). Nothing was updated.`);
        const sub = run.paths.find((p) => p !== "/");
        if (sub && (await smoke(info.url + sub, cookies)).status === 404) log(id, "Sub-pages return 404 on staging: the server ignores .htaccess (nginx). Only the home page can be compared.");
        note("Checking the staging environment matches live…");
        const live = readCare<CareStatus>(id, "status")!;
        const stg = await careStatus(stgAuth(site, info), false, info.token);
        if (!stg.staging || !stg.paths_ok) throw new Error("Safety check failed: the staging copy isn't isolated from the live files. No updates were run.");
        writeCare(id, "staging-before", stg);
        const env = compareEnv(live.env, stg.env, live.plugins, stg.plugins);
        writeCare(id, "env-check", env);
        log(id, env.matches ? `Staging matches live: WordPress ${stg.env.wp}, PHP ${stg.env.php}, ${stg.env.db}, ${stg.env.server || "same server"}` : `Environment differences: ${env.diffs.join("; ")}`);
        next("baseline");
        break;
      }

      case "baseline": {
        const stg = stagingInfo(id)!;
        const dir = runDir(id, run.id);
        mkdirSync(dir, { recursive: true });
        note(`Screenshotting ${run.paths.length} pages on staging before updating…`);
        const before = await capturePages(stg.url!, run.paths, dir, "stg-before", stagingCookie(stg.url!, stg.token!));
        writeCare(id, `runs/${run.id}/stg-before`, before);
        note("Testing forms on staging (email is captured there, nothing is sent)…");
        const forms = await testFormsOnStaging(site, stg, dir, "stg-before");
        writeCare(id, `runs/${run.id}/forms-before`, forms);
        setRun(id, (r) => (r.errorsSince = nowSec()));
        next("update-staging");
        break;
      }

      case "update-staging": {
        const stg = stagingInfo(id)!;
        const auth = stgAuth(site, stg);
        const cookies = stagingCookie(stg.url!, stg.token!);
        const order = { core: 0, plugin: 1, theme: 2, translations: 3 } as const;
        const todo = run.items.filter((i) => i.selected && !i.staging).sort((a, b) => order[a.kind] - order[b.kind]);
        for (const item of todo) {
          note(`Staging: updating ${item.name} ${item.from} → ${item.to}`);
          item.staging = await applyUpdate(auth, item, stg.url + "/", cookies, stg.token);
          log(id, `Staging · ${item.name}: ${item.staging.ok ? "updated" : "failed"} (${item.staging.note})`);
          setRun(id, (r) => {
            const it = r.items.find((x) => x.kind === item.kind && x.id === item.id);
            if (it) it.staging = item.staging;
          });
        }
        next("test-staging");
        break;
      }

      case "test-staging": {
        const stg = stagingInfo(id)!;
        const dir = runDir(id, run.id);
        const cookies = stagingCookie(stg.url!, stg.token!);
        note("Screenshotting staging after the updates…");
        const after = await capturePages(stg.url!, run.paths, dir, "stg-after", cookies);
        const pages = comparePages(dir, readCare<CarePageCheck[]>(id, `runs/${run.id}/stg-before`) ?? [], after, "stg");
        note("Testing forms again on staging…");
        const formsAfter = await testFormsOnStaging(site, stg, dir, "stg-after");
        const formsBefore = readCare<Awaited<ReturnType<typeof testFormsOnStaging>>>(id, `runs/${run.id}/forms-before`) ?? [];
        const forms: CareFormCheck[] = formsAfter.map((a) => {
          const b = formsBefore.find((x) => x.page === a.page && x.index === a.index);
          return { page: a.page, index: a.index, name: a.name, before: b?.ok ?? null, after: a.ok, mail: a.mail, detail: a.detail };
        });
        note("Reading PHP error logs on staging…");
        const auth = stgAuth(site, stg);
        const errors = await careErrors(auth, run.errorsSince ?? 0, stg.token).catch(() => null);
        const stgAfter = await careStatus(auth, false, stg.token);
        const off = deactivated(readCare<CareStatus>(id, "staging-before")?.plugins ?? [], stgAfter.plugins);
        const report = judge("staging", pages, forms, errors, readCare<{ matches: boolean; diffs: string[] }>(id, "env-check"), off, getCareSite(id)!.run!.items);
        setRun(id, (r) => {
          r.staging = report;
          r.step = "approve";
          r.status = "waiting";
          r.note = report.verdict === "pass" ? "Staging passed. Approve to update the live site." : report.verdict === "review" ? "Staging needs a look before going live." : "Staging found problems. Nothing has changed on live.";
        });
        addEvent({ leadId: null, kind: report.verdict === "fail" ? "failed" : report.verdict === "review" ? "review" : "ready", title: `Maintenance: staging ${report.verdict === "pass" ? "passed" : report.verdict === "review" ? "needs review" : "failed"}`, detail: `${site.name}: ${report.reasons.slice(0, 2).join(" · ") || "all checks passed"}. Waiting for your approval.` });
        return "Waiting for approval";
      }

      case "approve":
        setRun(id, (r) => (r.status = "waiting"));
        return "Waiting for approval";

      case "backup": {
        const auth = careAuth(site);
        const status = readCare<CareStatus>(id, "status")!;
        const fresh = await careStatus(auth).catch(() => status);
        if (fresh.backup.updraft) {
          note("Starting an UpdraftPlus backup of the live site…");
          await careBackup(auth, "start");
          const t0 = Date.now();
          for (;;) {
            await sleep(20000);
            await fetch(new URL(`/wp-cron.php?doing_wp_cron=${Date.now() / 1000}`, site.siteUrl), { signal: AbortSignal.timeout(20000) }).catch(() => {});
            const b = await careBackup(auth, "status");
            if (b.done) {
              if (!b.success) throw new Error(`UpdraftPlus finished with errors: ${(b.errors ?? []).join("; ") || "see UpdraftPlus → Existing backups"}. Live was not updated.`);
              setRun(id, (r) => (r.backup = { plugin: "UpdraftPlus", ok: true, at: new Date((b.time ?? nowSec()) * 1000).toISOString(), note: "Full backup: database, plugins, themes, uploads" }));
              log(id, "UpdraftPlus backup finished");
              break;
            }
            const mins = Math.round((Date.now() - t0) / 60000);
            if (mins > 90) throw new Error("The UpdraftPlus backup didn't finish within 90 minutes, so live was not updated. Check UpdraftPlus, then resume.");
            note(`Waiting for the UpdraftPlus backup to finish (${mins} min)…`);
          }
        } else {
          if (!run.backupConfirmed) throw new Error("No UpdraftPlus on this site: confirm you have a current backup when approving.");
          setRun(id, (r) => (r.backup = { plugin: fresh.backup.plugins.join(", ") || "Your own backup", ok: true, at: new Date().toISOString(), note: "You confirmed a current backup before approving" }));
        }
        next("update-live");
        break;
      }

      case "update-live": {
        const auth = careAuth(site);
        const dir = runDir(id, run.id);
        if (!readCare(id, `runs/${run.id}/live-before`)) {
          note("Screenshotting the live site before updating…");
          writeCare(id, `runs/${run.id}/live-before`, await capturePages(site.siteUrl, run.paths, dir, "live-before"));
          writeCare(id, `runs/${run.id}/live-status-before`, await careStatus(auth));
          setRun(id, (r) => (r.errorsSince = nowSec()));
        }
        const order = { core: 0, plugin: 1, theme: 2, translations: 3 } as const;
        const todo = run.items.filter((i) => i.selected && i.staging?.ok && !i.live).sort((a, b) => order[a.kind] - order[b.kind]);
        for (const item of todo) {
          note(`Live: updating ${item.name} ${item.from} → ${item.to}`);
          item.live = await applyUpdate(auth, item, site.siteUrl + "/", []);
          log(id, `Live · ${item.name}: ${item.live.ok ? "updated" : "failed"} (${item.live.note})`);
          setRun(id, (r) => {
            const it = r.items.find((x) => x.kind === item.kind && x.id === item.id);
            if (it) it.live = item.live;
          });
          if (!item.live.ok && !item.live.rolledBack && item.kind === "core") {
            addEvent({ leadId: null, kind: "failed", title: "Maintenance: WordPress core update failed on live", detail: `${site.name}: ${item.live.note}. Check the site now.` });
            throw new Error(`WordPress core update failed on live: ${item.live.note}. Remaining updates were stopped.`);
          }
        }
        next("verify-live");
        break;
      }

      case "verify-live": {
        const auth = careAuth(site);
        const dir = runDir(id, run.id);
        note("Screenshotting the live site after updating…");
        const after = await capturePages(site.siteUrl, run.paths, dir, "live-after");
        const pages = comparePages(dir, readCare<CarePageCheck[]>(id, `runs/${run.id}/live-before`) ?? [], after, "live");
        const errors = await careErrors(auth, run.errorsSince ?? 0).catch(() => null);
        const statusAfter = await careStatus(auth, true);
        writeCare(id, "status", statusAfter);
        const off = deactivated(readCare<CareStatus>(id, `runs/${run.id}/live-status-before`)?.plugins ?? [], statusAfter.plugins);
        const report = judge("live", pages, [], errors, null, off, getCareSite(id)!.run!.items);

        if (site.seoSiteId && getSite(site.seoSiteId)) {
          const prevPerf = readResult<PerfResult>(site.seoSiteId, "perf");
          const prevForms = readResult<QaResult>(site.seoSiteId, "qa")?.forms.length ?? null;
          try {
            note("Post-update QA: links, copy and forms present (nothing is submitted)…");
            await runSeoPhase(site.seoSiteId, "qa");
            note("Post-update speed test…");
            await runSeoPhase(site.seoSiteId, "perf");
            note("Post-update on-page SEO audit…");
            await runSeoPhase(site.seoSiteId, "onpage");
            const perf = readResult<PerfResult>(site.seoSiteId, "perf");
            const avg = (p: PerfResult | null) => (p?.pages.length ? Math.round(p.pages.reduce((a, x) => a + (x.mobile?.score ?? 0), 0) / p.pages.length) : null);
            const [b, a] = [avg(prevPerf), avg(perf)];
            if (b !== null && a !== null) {
              log(id, `Mobile speed score ${b} → ${a}`);
              if (a < b - 10) {
                report.reasons.push(`Mobile speed dropped from ${b} to ${a}`);
                if (report.verdict === "pass") report.verdict = "review";
              }
            }
            const forms = readResult<QaResult>(site.seoSiteId, "qa")?.forms.length ?? null;
            if (prevForms !== null && forms !== null && forms < prevForms) {
              report.reasons.push(`${prevForms - forms} form(s) no longer found on the site`);
              report.verdict = "fail";
            }
          } catch (e) {
            report.reasons.push(`Post-update SEO checks didn't finish: ${(e as Error).message.slice(0, 120)}`);
          }
        }

        if (!getSettings().careKeepStaging) {
          note("Removing the staging copy…");
          await careStaging(auth, "delete").catch(() => {});
          writeCare(id, "staging", { status: "none" });
        }
        setRun(id, (r) => (r.live = report));
        const updated = getCareSite(id)!.run!.items.filter((i) => i.live?.ok).length;
        finish(id, report.verdict, `${updated} update${updated === 1 ? "" : "s"} applied to live. ${report.verdict === "pass" ? "All checks passed." : report.reasons.slice(0, 2).join(" · ")}`);
        addEvent({ leadId: null, kind: report.verdict === "fail" ? "failed" : report.verdict === "review" ? "review" : "ready", title: `Maintenance finished: ${site.name}`, detail: `${updated} updates applied · ${report.verdict === "pass" ? "all checks passed" : report.reasons[0]}` });
        await scanSite(id, progress).catch(() => {});
        return `${updated} updates applied`;
      }

      case "done":
        return run.note;
    }
  }
}

/** Update one item, then make sure the home page still renders; roll back plugins/themes that break it. */
async function applyUpdate(auth: WpAuth, item: CareUpdateItem, homeUrl: string, cookies: ReturnType<typeof stagingCookie>, token?: string): Promise<NonNullable<CareUpdateItem["staging"]>> {
  try {
    const r = await careUpdate(auth, item.kind, item.id, token);
    if (!r.ok) return { ok: false, note: r.errors.join("; ") || (r.from === r.to ? "The version didn't change" : "Update failed") };
    if (item.kind === "core") await careDbUpgrade(auth, token).catch(() => {});
    const sm = await smoke(homeUrl, cookies);
    if (sm.ok) return { ok: true, note: item.kind === "translations" ? "Updated" : `${r.from} → ${r.to}` };
    const why = `the home page broke (HTTP ${sm.status}${sm.fatal ? ", PHP fatal error" : ""})`;
    if (item.kind === "plugin" || item.kind === "theme") {
      await careRollback(auth, item.kind, item.id, token);
      const back = await smoke(homeUrl, cookies);
      return { ok: false, note: `${why}; rolled back to ${item.from}${back.ok ? "" : " but the site still has errors"}`, rolledBack: true };
    }
    return { ok: false, note: why };
  } catch (e) {
    return { ok: false, note: (e as Error).message.slice(0, 300) };
  }
}

function judge(target: "staging" | "live", pages: CarePageCheck[], forms: CareFormCheck[], errors: { counts: { fatal: number; warning: number }; fatal: string[] } | null, env: { matches: boolean; diffs: string[] } | null, off: string[], items: CareUpdateItem[]): CareTestReport {
  const threshold = getSettings().careDiffThreshold || 1;
  const fail: string[] = [];
  const review: string[] = [];
  for (const p of pages) {
    const was = p.beforeStatus ?? 200;
    if ((p.status >= 400 || p.status === 0) && was > 0 && was < 400) fail.push(`${p.path} now returns ${p.status || "nothing"} (was ${was})`);
    if (p.fatal) fail.push(`${p.path} shows a PHP error`);
    if (p.diff !== null && p.diff > threshold) review.push(`${p.path} looks ${p.diff}% different`);
    if (p.consoleErrors > (p.beforeConsole ?? 0)) review.push(`${p.path}: ${p.consoleErrors - (p.beforeConsole ?? 0)} new JavaScript error(s)`);
  }
  for (const f of forms) {
    if (f.before === true && f.after === false) fail.push(`Form "${f.name}" on ${f.page} stopped working`);
    else if (f.after === false) review.push(`Form "${f.name}" on ${f.page} fails (it failed before the updates too)`);
    if (f.after && f.mail === false) review.push(`Form "${f.name}" submitted but no notification email was generated`);
  }
  if (errors?.counts.fatal) fail.push(`${errors.counts.fatal} new PHP fatal error(s) in the log`);
  if (off.length) fail.push(`Deactivated after the update: ${off.join(", ")}`);
  if (env && !env.matches) review.push(`Staging differs from live: ${env.diffs.slice(0, 3).join("; ")}`);
  const key = target === "staging" ? "staging" : "live";
  for (const i of items.filter((x) => x[key] && !x[key]!.ok)) (target === "live" ? fail : review).push(`${i.name}: ${i[key]!.note}${target === "staging" ? " (won't be applied to live)" : ""}`);
  return {
    at: new Date().toISOString(),
    target,
    pages,
    forms,
    errors: { fatal: errors?.counts.fatal ?? 0, warning: errors?.counts.warning ?? 0, lines: errors?.fatal ?? [] },
    env,
    deactivated: off,
    verdict: fail.length ? "fail" : review.length ? "review" : "pass",
    reasons: [...fail, ...review],
  };
}

function finish(id: string, verdict: "pass" | "review" | "fail", text: string) {
  updateCareSite(id, (s) => {
    if (!s.run) return;
    s.run.step = "done";
    s.run.status = "done";
    s.run.finishedAt = new Date().toISOString();
    s.run.note = text;
    s.history.unshift({ id: s.run.id, month: s.run.month, finishedAt: s.run.finishedAt, updated: s.run.items.filter((i) => i.live?.ok).length, verdict, note: text });
    s.history = s.history.slice(0, 36);
    writeCare(id, `runs/${s.run.id}/run`, s.run);
  });
}
