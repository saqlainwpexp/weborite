import { Router } from "express";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { addEvent, getSettings } from "../db.ts";
import type { CareIntegrity, CareSite, CareStagingInfo } from "../../shared/types.ts";
import { createSite, getSite, listSites, saveSite, setSiteSecret, siteSecrets } from "../seo/store.ts";
import { getConversion, getSecrets } from "../wp/store.ts";
import { sitePlugin } from "../seo/routes.ts";
import { careHarden, careIntegrity, careRollback, careStaging, careTidy } from "./client.ts";
import { pingSite } from "./health.ts";
import { careAuth, continueRun, newRun, scanSite, type Progress } from "./pipeline.ts";
import { reportPdf } from "./report.ts";
import { CARE_DIR, careDir, createCareSite, deleteCareRow, getCareSite, listCareSites, readCare, setCareSecret, updateCareSite, writeCare } from "./store.ts";

/* ---------- one maintenance job at a time (clones and updates are heavy on the client's server) ---------- */

type Job = { siteId: string; kind: string; run: (progress: Progress) => Promise<string> };
const queue: Job[] = [];
let active: Job | null = null;

function enqueue(job: Job) {
  updateCareSite(job.siteId, (s) => (s.job = { kind: job.kind, status: "running", note: queue.length || active ? "Queued" : "Starting…", startedAt: new Date().toISOString() }));
  queue.push(job);
  void pump();
}

const busy = (id: string) => active?.siteId === id || queue.some((j) => j.siteId === id);

async function pump() {
  if (active) return;
  const job = queue.shift();
  if (!job) return;
  active = job;
  const progress: Progress = (note) => updateCareSite(job.siteId, (s) => s.job && (s.job.note = note));
  try {
    const note = await job.run(progress);
    updateCareSite(job.siteId, (s) => (s.job = { ...s.job!, status: "done", note, finishedAt: new Date().toISOString() }));
  } catch (e) {
    const msg = (e as Error).message.slice(0, 400);
    updateCareSite(job.siteId, (s) => {
      s.job = { ...s.job!, status: "failed", note: msg, finishedAt: new Date().toISOString() };
      if (job.kind === "run" && s.run && s.run.status === "running") {
        s.run.status = "failed";
        s.run.note = msg;
        s.run.log.push({ at: new Date().toISOString(), text: `Stopped: ${msg}` });
      }
    });
    const s = getCareSite(job.siteId);
    addEvent({ leadId: null, kind: "failed", title: `Maintenance stopped: ${s?.name ?? job.siteId}`, detail: msg });
    console.error(`[care ${job.siteId} ${job.kind}]`, e);
  } finally {
    active = null;
    void pump();
  }
}

const runJob = (siteId: string): Job => ({ siteId, kind: "run", run: (p) => continueRun(siteId, p) });

/** A restart kills in-flight jobs: mark them so they can be resumed. */
for (const s of listCareSites()) {
  if (s.job?.status === "running" || s.run?.status === "running") {
    updateCareSite(s.id, (x) => {
      if (x.job?.status === "running") x.job = { ...x.job, status: "failed", note: "Interrupted: the app was restarted", finishedAt: new Date().toISOString() };
      if (x.run?.status === "running") {
        x.run.status = "failed";
        x.run.note = "Interrupted when the app restarted. Resume to carry on from this step.";
      }
    });
  }
}

/* ---------- routes ---------- */

export const care = Router();

const view = (s: CareSite) => ({ ...s, busy: busy(s.id) });

care.get("/", (_req, res) => res.json(listCareSites().map(view)));

care.post("/", (req, res) => {
  // "Add from Launch & SEO": reuse that site's saved WordPress login without it ever leaving the server.
  const from = req.body?.fromSeo ? getSite(String(req.body.fromSeo)) : null;
  if (req.body?.fromSeo && !from) return res.status(404).json({ error: "That Launch & SEO site no longer exists" });
  const conv = from?.conversionId ? getConversion(from.conversionId) : null;
  let siteUrl = String(from?.siteUrl ?? req.body?.siteUrl ?? "");
  try {
    siteUrl = new URL(siteUrl).origin;
  } catch {
    return res.status(400).json({ error: "Enter the site's address, e.g. https://client-site.com" });
  }
  if (listCareSites().some((s) => s.siteUrl === siteUrl)) return res.status(409).json({ error: "This site is already in maintenance" });
  const wpUser = String(conv?.wpUser ?? from?.wpUser ?? req.body?.wpUser ?? "").trim();
  const appPassword = String(conv ? getSecrets(conv.id).secret : from ? siteSecrets(from.id).secret : req.body?.appPassword ?? "").trim();
  if (!wpUser || !appPassword) return res.status(400).json({ error: from ? "That site has no saved WordPress login: add the username and Application Password here instead" : "Enter the administrator username and an Application Password" });
  const name = String(req.body?.name ?? "").trim() || from?.name || new URL(siteUrl).hostname.replace(/^www\./, "");
  // Share the Launch & SEO site for after-update checks (create one if needed).
  let seo = from ?? listSites().find((x) => x.siteUrl === siteUrl) ?? null;
  if (!seo) seo = createSite({ name, siteUrl, conversionId: null, wpUser, appPassword });
  else if (!seo.conversionId && appPassword) {
    setSiteSecret(seo.id, appPassword);
    seo.wpUser = wpUser;
    seo.appPasswordSet = true;
    saveSite(seo);
  }
  const s = createCareSite({ name, siteUrl, wpUser, appPassword, client: String(req.body?.client ?? "").trim(), seoSiteId: seo.id });
  res.json(view(s));
});

care.get("/:id", (req, res) => {
  const s = getCareSite(req.params.id);
  if (!s) return res.sendStatus(404);
  res.json(view(s));
});

/** Everything the detail page shows besides the site record. */
care.get("/:id/data", (req, res) => {
  const s = getCareSite(req.params.id);
  if (!s) return res.sendStatus(404);
  const uptime = (readCare<[number, number, number][]>(s.id, "uptime") ?? []).slice(-2016); // 14 days at 10 min
  res.json({
    status: readCare(s.id, "status"),
    intel: readCare(s.id, "intel"),
    health: readCare(s.id, "health"),
    integrity: readCare(s.id, "integrity"),
    hardening: readCare(s.id, "hardening"),
    staging: readCare(s.id, "staging"),
    env: readCare(s.id, "env-check"),
    uptime,
  });
});

care.put("/:id", (req, res) => {
  const s = getCareSite(req.params.id);
  if (!s) return res.sendStatus(404);
  const next = updateCareSite(s.id, (x) => {
    if (typeof req.body?.name === "string" && req.body.name.trim()) x.name = req.body.name.trim();
    if (typeof req.body?.client === "string") x.client = req.body.client.trim();
    if (typeof req.body?.wpUser === "string" && req.body.wpUser.trim()) x.wpUser = req.body.wpUser.trim();
    if (typeof req.body?.appPassword === "string" && req.body.appPassword.trim()) x.appPasswordSet = true;
  })!;
  if (typeof req.body?.appPassword === "string" && req.body.appPassword.trim()) {
    setCareSecret(s.id, req.body.appPassword.trim());
    const seo = next.seoSiteId ? getSite(next.seoSiteId) : null;
    if (seo && !seo.conversionId) {
      setSiteSecret(seo.id, req.body.appPassword.trim());
      seo.wpUser = next.wpUser;
      seo.appPasswordSet = true;
      saveSite(seo);
    }
  }
  res.json(view(next));
});

care.get("/:id/plugin", async (req, res) => {
  const s = getCareSite(req.params.id);
  const seo = s?.seoSiteId ? getSite(s.seoSiteId) : null;
  if (!s || !seo) return res.sendStatus(404);
  const file = await sitePlugin(seo);
  if (!existsSync(file)) return res.sendStatus(404);
  res.download(file, "studio-connector.zip");
});

care.post("/:id/scan", (req, res) => {
  const s = getCareSite(req.params.id);
  if (!s) return res.sendStatus(404);
  if (busy(s.id)) return res.status(409).json({ error: "Something is already running for this site" });
  enqueue({ siteId: s.id, kind: "scan", run: (p) => scanSite(s.id, p) });
  res.json({ ok: true });
});

care.post("/:id/integrity", (req, res) => {
  const s = getCareSite(req.params.id);
  if (!s) return res.sendStatus(404);
  if (busy(s.id)) return res.status(409).json({ error: "Something is already running for this site" });
  enqueue({
    siteId: s.id, kind: "integrity", run: async (p) => {
      p("Comparing every core and plugin file with the official releases…");
      const r = await careIntegrity(careAuth(getCareSite(s.id)!));
      const data: CareIntegrity = { at: new Date().toISOString(), ...r };
      writeCare(s.id, "integrity", data);
      const bad = r.core.modified.length + r.core.unknown.length + r.plugins.reduce((a, x) => a + x.modified.length + x.added.length, 0) + r.uploads_php.length;
      return bad ? `${bad} files differ from the official releases` : "All files match the official releases";
    },
  });
  res.json({ ok: true });
});

/** Start this month's maintenance: scan → staging → tests → wait for approval. */
care.post("/:id/run", (req, res) => {
  const s = getCareSite(req.params.id);
  if (!s) return res.sendStatus(404);
  if (busy(s.id)) return res.status(409).json({ error: "Something is already running for this site" });
  if (s.run && ["running", "waiting"].includes(s.run.status)) return res.status(409).json({ error: "Finish or cancel the current maintenance run first" });
  updateCareSite(s.id, (x) => (x.run = newRun("manual")));
  enqueue(runJob(s.id));
  res.json({ ok: true });
});

care.post("/:id/run/approve", (req, res) => {
  const s = getCareSite(req.params.id);
  if (!s?.run) return res.sendStatus(404);
  if (s.run.step !== "approve") return res.status(409).json({ error: "This run isn't waiting for approval" });
  const ids: string[] = Array.isArray(req.body?.items) ? req.body.items.map(String) : [];
  const chosen = s.run.items.filter((i) => ids.includes(`${i.kind}:${i.id}`) && i.staging?.ok);
  if (!chosen.length) return res.status(400).json({ error: "Pick at least one update that passed on staging" });
  const status = readCare<{ backup: { updraft: boolean } }>(s.id, "status");
  if (!status?.backup.updraft && req.body?.backupConfirmed !== true) return res.status(400).json({ error: "This site has no UpdraftPlus: confirm you have a current backup first" });
  updateCareSite(s.id, (x) => {
    for (const i of x.run!.items) i.selected = chosen.some((c) => c.kind === i.kind && c.id === i.id);
    x.run!.approvedAt = new Date().toISOString();
    x.run!.backupConfirmed = req.body?.backupConfirmed === true;
    x.run!.step = "backup";
    x.run!.status = "running";
    x.run!.note = "Approved";
    x.run!.log.push({ at: new Date().toISOString(), text: `Approved for live: ${chosen.map((c) => c.name).join(", ")}` });
  });
  enqueue(runJob(s.id));
  res.json({ ok: true });
});

care.post("/:id/run/resume", (req, res) => {
  const s = getCareSite(req.params.id);
  if (!s?.run) return res.sendStatus(404);
  if (busy(s.id)) return res.status(409).json({ error: "Already running" });
  if (s.run.status !== "failed") return res.status(409).json({ error: "Only a stopped run can be resumed" });
  if (["backup", "update-live", "verify-live"].includes(s.run.step) && !s.run.approvedAt) return res.status(409).json({ error: "Not approved" });
  updateCareSite(s.id, (x) => {
    x.run!.status = "running";
    x.run!.log.push({ at: new Date().toISOString(), text: `Resumed at step: ${x.run!.step}` });
  });
  enqueue(runJob(s.id));
  res.json({ ok: true });
});

care.post("/:id/run/cancel", async (req, res) => {
  const s = getCareSite(req.params.id);
  if (!s?.run) return res.sendStatus(404);
  if (active?.siteId === s.id) return res.status(409).json({ error: "Wait for the current step to finish, then cancel" });
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].siteId === s.id) queue.splice(i, 1);
  updateCareSite(s.id, (x) => {
    x.run!.status = "cancelled";
    x.run!.note = "Cancelled";
    x.run!.finishedAt = new Date().toISOString();
    if (x.job?.status === "running") x.job = { ...x.job, status: "done", note: "Cancelled" };
  });
  // The staging copy has no further use.
  const stg = readCare<CareStagingInfo>(s.id, "staging");
  if (stg && stg.status !== "none" && !getSettings().careKeepStaging) {
    await careStaging(careAuth(s), "delete").catch(() => {});
    writeCare(s.id, "staging", { status: "none" });
  }
  res.json({ ok: true });
});

/** Put a plugin or theme back to the copy taken right before its update (live). Explicit click only. */
care.post("/:id/rollback", (req, res) => {
  const s = getCareSite(req.params.id);
  if (!s) return res.sendStatus(404);
  if (req.body?.confirm !== true) return res.status(400).json({ error: "Confirm the rollback" });
  const kind = req.body?.kind === "theme" ? "theme" : "plugin";
  const id = String(req.body?.id ?? "");
  if (busy(s.id)) return res.status(409).json({ error: "Something is already running for this site" });
  enqueue({
    siteId: s.id, kind: "rollback", run: async (p) => {
      p(`Rolling back ${id}…`);
      const r = await careRollback(careAuth(s), kind, id);
      updateCareSite(s.id, (x) => {
        const it = x.run?.items.find((i) => i.kind === kind && i.id === id);
        if (it?.live) it.live = { ...it.live, rolledBack: true, note: `${it.live.note}; rolled back to ${r.version} by you` };
      });
      await scanSite(s.id, p);
      return `Rolled back to ${r.version}`;
    },
  });
  res.json({ ok: true });
});

care.post("/:id/tidy", (req, res) => {
  const s = getCareSite(req.params.id);
  if (!s) return res.sendStatus(404);
  if (req.body?.confirm !== true) return res.status(400).json({ error: "Confirm the database clean-up" });
  if (busy(s.id)) return res.status(409).json({ error: "Something is already running for this site" });
  enqueue({
    siteId: s.id, kind: "tidy", run: async (p) => {
      p("Cleaning the database…");
      const r = await careTidy(careAuth(s));
      await scanSite(s.id, p);
      return `Removed ${r.transients} expired transients, ${r.comments} spam/trash comments, ${r.auto_drafts} auto-drafts, ${r.revisions} old revisions`;
    },
  });
  res.json({ ok: true });
});

/** Install and configure Wordfence (brute-force protection, login rules) and switch XML-RPC off. */
care.post("/:id/harden", (req, res) => {
  const s = getCareSite(req.params.id);
  if (!s) return res.sendStatus(404);
  if (req.body?.confirm !== true) return res.status(400).json({ error: "Confirm the security changes" });
  if (busy(s.id)) return res.status(409).json({ error: "Something is already running for this site" });
  if ((s.connected?.care ?? 0) < 2) return res.status(409).json({ error: "The Studio Connector on this site is too old for this. Download it again from this page and upload it under Plugins → Add New → Upload." });
  enqueue({
    siteId: s.id, kind: "harden", run: async (p) => {
      p("Installing and configuring Wordfence…");
      const r = await careHarden(careAuth(s));
      writeCare(s.id, "hardening", { ...r, at: new Date().toISOString() });
      await scanSite(s.id, p);
      const applied = r.settings.filter((x) => x.ok).length;
      return `Wordfence ${r.version}${r.installed ? " installed" : ""}${r.activated ? " and activated" : ""}; ${applied}/${r.settings.length} settings applied; XML-RPC switched off`;
    },
  });
  res.json({ ok: true });
});

care.post("/:id/staging/delete", async (req, res) => {
  const s = getCareSite(req.params.id);
  if (!s) return res.sendStatus(404);
  if (busy(s.id)) return res.status(409).json({ error: "Something is already running for this site" });
  try {
    await careStaging(careAuth(s), "delete");
    writeCare(s.id, "staging", { status: "none" });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** Screenshots and diffs from a run. */
care.get("/:id/shot/:run/:file", (req, res) => {
  const { id, run, file } = req.params;
  if (!/^[a-f0-9]{8}$/.test(id) || !/^\d{12}$/.test(run) || !/^[a-z0-9-]+\.png$/i.test(file)) return res.sendStatus(400);
  const p = join(careDir(id), "runs", run, file);
  if (!existsSync(p)) return res.sendStatus(404);
  res.sendFile(p);
});

care.get("/:id/report", async (req, res) => {
  const s = getCareSite(req.params.id);
  if (!s) return res.sendStatus(404);
  const runId = String(req.query.run ?? "");
  const run = runId ? (s.run?.id === runId ? s.run : readCare<CareSite["run"]>(s.id, `runs/${runId}/run`)) : s.run?.status === "done" ? s.run : null;
  try {
    const file = await reportPdf(s, run ?? null);
    res.download(file, `${s.name.replace(/[^a-z0-9]+/gi, "-")}-care-report-${(run?.month ?? new Date().toISOString().slice(0, 7))}.pdf`);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

care.delete("/:id", async (req, res) => {
  const s = getCareSite(req.params.id);
  if (!s) return res.sendStatus(404);
  if (busy(s.id)) return res.status(409).json({ error: "Wait for the running job to finish" });
  const stg = readCare<CareStagingInfo>(s.id, "staging");
  if (stg && stg.status !== "none") await careStaging(careAuth(s), "delete").catch(() => {});
  deleteCareRow(s.id);
  rmSync(careDir(s.id), { recursive: true, force: true });
  res.json({ ok: true });
});

/* ---------- timers: uptime every 10 minutes, the monthly check every 30 ---------- */

const SCHEDULE = "schedule";

function monthlyDue() {
  const { careDay } = getSettings();
  if (!careDay) return false;
  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const last = readCare<{ month: string }>("_", SCHEDULE)?.month;
  return last !== month && now.getDate() >= careDay && now.getHours() >= 6;
}

function runMonthly() {
  const month = new Date().toISOString().slice(0, 7);
  writeCare("_", SCHEDULE, { month, at: new Date().toISOString() });
  const { careAutoStage } = getSettings();
  const sites = listCareSites();
  for (const s of sites) {
    if (busy(s.id) || (s.run && ["running", "waiting"].includes(s.run.status))) continue;
    if (careAutoStage) {
      updateCareSite(s.id, (x) => (x.run = newRun("schedule")));
      enqueue(runJob(s.id));
    } else {
      enqueue({ siteId: s.id, kind: "scan", run: (p) => scanSite(s.id, p) });
    }
  }
  if (sites.length) addEvent({ leadId: null, kind: "info", title: "Monthly maintenance started", detail: `${sites.length} sites: ${careAutoStage ? "updates are tested on staging, then wait for your approval" : "scanning for updates and vulnerabilities"}` });
}

export function startCareTimers() {
  const uptime = async () => {
    for (const s of listCareSites()) {
      const status = await pingSite(s.id, s.siteUrl).catch(() => 0);
      const prev = (readCare<[number, number, number][]>(s.id, "uptime") ?? []).slice(-2, -1)[0];
      const down = !(status > 0 && status < 500);
      if (down && prev && prev[1] > 0 && prev[1] < 500) addEvent({ leadId: null, kind: "failed", title: `${s.name} is down`, detail: status ? `HTTP ${status}` : "No response" });
      if (!down && prev && !(prev[1] > 0 && prev[1] < 500)) addEvent({ leadId: null, kind: "info", title: `${s.name} is back up`, detail: `HTTP ${status}` });
    }
  };
  setTimeout(() => void uptime(), 20000);
  setInterval(() => void uptime(), 10 * 60 * 1000);
  const check = () => monthlyDue() && runMonthly();
  setTimeout(check, 60000);
  setInterval(check, 30 * 60 * 1000);
}

export { CARE_DIR };
