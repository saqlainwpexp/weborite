import express, { type Request } from "express";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec } from "node:child_process";
// @ts-expect-error archiver v8 ships without type declarations
import { ZipArchive } from "archiver";
import {
  API_PORT, BRAND_DIR, BUILDS_DIR, LEADS_DIR, ROOT, deleteLeadRow, encryptStoredSecrets, getLead, getSettings, leadDir, listEvents, listLeads,
  normalizeUrl, publicSettings, readJson, saveLead, setSettings, usageToday,
} from "./db.ts";
import { enqueue, queueState, resumeInterrupted } from "./queue.ts";
import { hooks, intakeLead } from "./intake.ts";
import { getBenchmarkSet, listBenchmarkSets, saveBenchmarkSet } from "./pipeline/benchmarks.ts";
import { finder } from "./finder/routes.ts";
import { resumeSearches } from "./finder/queue.ts";
import { builds } from "./builds/routes.ts";
import { resumeBuilds } from "./builds/queue.ts";
import { resumeWp, wp } from "./wp/routes.ts";
import { WP_DIR } from "./wp/store.ts";
import { seo } from "./seo/routes.ts";
import { SEO_DIR } from "./seo/store.ts";
import { care, startCareTimers } from "./care/routes.ts";
import { comms } from "./comms.ts";
import { admin } from "./admin.ts";
import { agent } from "./agent/routes.ts";
import { assertPublicUrl, localOnly, sandboxFiles } from "./security.ts";
import { STEPS, type BenchmarkSet, type Capture, type Diagnosis, type GateResult, type LeadDetail, type StepKey, type Usage } from "../shared/types.ts";

// Every store has created its tables by now: encrypt anything saved before encryption existed.
encryptStoredSecrets();

const PORT = API_PORT;
const HOOK_PORT = Number(process.env.HOOK_PORT ?? 4001);

const rawJson = express.json({
  limit: "2mb",
  verify: (req, _res, buf) => ((req as Request & { rawBody?: Buffer }).rawBody = buf),
});

// ---- Dashboard + API (local only) ----
const app = express();
app.disable("x-powered-by");
app.use(localOnly);
app.use(rawJson);
app.use(express.urlencoded({ extended: true }));

app.get("/api/leads", (_req, res) => res.json(listLeads()));

app.get("/api/leads/:id", (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.sendStatus(404);
  const detail: LeadDetail = {
    ...lead,
    capture: readJson<Capture>(lead.id, "capture.json"),
    diagnosis: readJson<Diagnosis>(lead.id, "diagnosis.json"),
    gate: readJson<GateResult>(lead.id, "gate.json"),
    benchmarks: lead.vertical ? getBenchmarkSet(lead.vertical) : null,
    hasMockup: existsSync(join(leadDir(lead.id), "mockup", "index.html")),
    hasSideBySide: existsSync(join(leadDir(lead.id), "side-by-side.png")),
  };
  res.json(detail);
});

app.post("/api/leads", async (req, res) => {
  const { url, name = "", email = "", phone = "", business = "" } = req.body ?? {};
  let normalized: string;
  try {
    normalized = normalizeUrl(String(url ?? ""));
  } catch {
    return res.status(400).json({ error: "Enter a valid website URL" });
  }
  try {
    await assertPublicUrl(normalized);
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message });
  }
  const { lead, duplicate } = intakeLead({ source: "manual", url: normalized, name, email, phone, business, fields: { Website: normalized, ...(name && { Name: name }), ...(email && { Email: email }), ...(phone && { Phone: phone }), ...(business && { Business: business }) } });
  res.json({ id: lead.id, duplicate });
});

app.post("/api/leads/:id/run", (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.sendStatus(404);
  const from = req.body?.from as StepKey | undefined;
  if (from) {
    const idx = STEPS.findIndex((s) => s.key === from);
    lead.steps.forEach((s, i) => {
      if (i >= idx) Object.assign(s, { status: "pending", note: undefined, startedAt: undefined, finishedAt: undefined });
    });
    saveLead(lead);
  }
  enqueue(lead.id);
  res.json({ ok: true });
});

app.delete("/api/leads/:id", (req, res) => {
  deleteLeadRow(req.params.id);
  rmSync(leadDir(req.params.id), { recursive: true, force: true });
  res.json({ ok: true });
});

app.get("/api/leads/:id/export", (req, res) => {
  const lead = getLead(req.params.id);
  const dir = lead && leadDir(lead.id);
  if (!lead || !existsSync(join(dir!, "mockup", "index.html"))) return res.sendStatus(404);
  const host = new URL(lead.url).hostname.replace(/^www\./, "");
  res.attachment(`${host}-mockup.zip`);
  const zip = new ZipArchive({ zlib: { level: 6 } });
  zip.pipe(res);
  zip.directory(join(dir!, "mockup"), "mockup");
  zip.directory(join(dir!, "assets"), "assets");
  if (existsSync(join(dir!, "side-by-side.png"))) zip.file(join(dir!, "side-by-side.png"), { name: "side-by-side.png" });
  void zip.finalize();
});

app.use("/api/finder", finder);
app.use("/api/builds", builds);
app.use("/api/wp", wp);
app.use("/api/seo", seo);
app.use("/api/care", care);
app.use("/api/comms", comms);
app.use("/api/admin", admin);
app.use("/api/agent", agent);

app.get("/api/events", (_req, res) => res.json(listEvents(40)));

app.get("/api/usage", (_req, res) => {
  const s = getSettings();
  const u: Usage = { mode: s.mode, ...usageToday(), ...queueState() };
  res.json(u);
});

app.get("/api/settings", (_req, res) => res.json(publicSettings()));
app.put("/api/settings", (req, res) => {
  const allowed = [
    "mode", "apiKey", "generateModel", "fastModel", "metaPageToken", "metaAppSecret", "metaVerifyToken", "elementorSecret", "claudePath",
    "studioName", "brandColor", "firstName", "lastName", "userEmail", "userPhone",
    "psiKey", "gtmetrixKey", "qaEmail",
  ];
  if (typeof req.body?.currency === "string" && !/^[A-Z]{3}$/.test(req.body.currency)) return res.status(400).json({ error: "Currency must be a 3-letter code like USD" });
  if (typeof req.body?.currency === "string") allowed.push("currency");
  const patch = Object.fromEntries(Object.entries(req.body ?? {}).filter(([k, v]) => allowed.includes(k) && typeof v === "string"));
  const list = req.body?.seoChecklist;
  if (Array.isArray(list)) {
    (patch as Record<string, unknown>).seoChecklist = list
      .map((i: { label?: unknown; group?: unknown }) => ({ label: String(i?.label ?? "").trim().slice(0, 160), group: String(i?.group ?? "Custom").trim().slice(0, 40) || "Custom" }))
      .filter((i: { label: string }) => i.label)
      .slice(0, 80);
  }
  const body = req.body ?? {};
  const extra = patch as Record<string, unknown>;
  if (body.careDay !== undefined) extra.careDay = Math.max(0, Math.min(28, Math.round(Number(body.careDay)) || 0));
  if (body.careDiffThreshold !== undefined) extra.careDiffThreshold = Math.max(0.1, Math.min(20, Number(body.careDiffThreshold) || 1));
  if (typeof body.careAutoStage === "boolean") extra.careAutoStage = body.careAutoStage;
  if (typeof body.careKeepStaging === "boolean") extra.careKeepStaging = body.careKeepStaging;
  if ("brandColor" in patch && !/^#[0-9a-f]{6}$/i.test(patch.brandColor as string)) return res.status(400).json({ error: "Brand colour must be a 6-digit hex like #a36566" });
  // The Claude path is run through the shell on Windows, so it must be a plain path.
  if ("claudePath" in patch && (!String(patch.claudePath).trim() || /[&|<>^%!"`$;\r\n]/.test(String(patch.claudePath)))) return res.status(400).json({ error: "The Claude Code path must be a plain file path or command name" });
  for (const k of ["elementorSecret", "metaVerifyToken"] as const) {
    if (k in patch && !/^[\w-]{12,128}$/.test(String(patch[k]))) return res.status(400).json({ error: "Webhook secrets need at least 12 letters or numbers" });
  }
  setSettings(patch);
  res.json(publicSettings());
});

// White-label images: the body is the raw image file.
const IMAGE_EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/svg+xml": ".svg" };
app.post("/api/brand/:kind", express.raw({ type: Object.keys(IMAGE_EXT), limit: "5mb" }), (req, res) => {
  const kind = req.params.kind;
  const ext = IMAGE_EXT[req.get("content-type") ?? ""];
  if ((kind !== "logo" && kind !== "avatar") || !ext || !Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: "Upload a PNG, JPEG, WebP or SVG image up to 5 MB" });
  }
  const file = `${kind}-${Date.now()}${ext}`;
  writeFileSync(join(BRAND_DIR, file), req.body);
  const prev = getSettings()[kind === "logo" ? "logoFile" : "avatarFile"];
  if (prev) rmSync(join(BRAND_DIR, prev), { force: true });
  setSettings(kind === "logo" ? { logoFile: file } : { avatarFile: file });
  res.json(publicSettings());
});
app.delete("/api/brand/:kind", (req, res) => {
  const key = req.params.kind === "logo" ? "logoFile" : req.params.kind === "avatar" ? "avatarFile" : null;
  if (!key) return res.sendStatus(400);
  const prev = getSettings()[key];
  if (prev) rmSync(join(BRAND_DIR, prev), { force: true });
  setSettings({ [key]: "" });
  res.json(publicSettings());
});

app.get("/api/claude/status", (_req, res) => {
  const s = getSettings();
  const win = process.platform === "win32";
  const cmd = `${win && s.claudePath.includes(" ") ? `"${s.claudePath}"` : s.claudePath} --version`;
  exec(cmd, { timeout: 15000, windowsHide: true }, (err, stdout) => {
    res.json({ cli: err ? null : stdout.trim(), apiKeySet: Boolean(s.apiKey), mode: s.mode });
  });
});

app.get("/api/benchmarks", (_req, res) => {
  const leads = listLeads();
  res.json(listBenchmarkSets().map((b) => ({ ...b, leadCount: leads.filter((l) => l.vertical === b.vertical).length })));
});
app.put("/api/benchmarks/:key", (req, res) => {
  const cur = getBenchmarkSet(req.params.key);
  if (!cur) return res.sendStatus(404);
  const next: BenchmarkSet = { ...cur, ...req.body, vertical: cur.vertical };
  saveBenchmarkSet(next);
  res.json(next);
});

// Lead files: screenshots, assets, mockups. Mockups load their assets via ../assets/.
app.use("/files", sandboxFiles);
app.use("/files/leads", express.static(LEADS_DIR, { fallthrough: false }));
app.use("/files/brand", express.static(BRAND_DIR, { fallthrough: false }));
app.use("/files/builds", express.static(BUILDS_DIR, { fallthrough: false }));
app.use("/files/wp", express.static(WP_DIR, { fallthrough: false, index: false }));
app.use("/files/seo", express.static(SEO_DIR, { fallthrough: false, index: false, extensions: [] }));

// Production build of the dashboard.
const dist = join(ROOT, "dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|files).*/, (_req, res) => res.sendFile(join(dist, "index.html")));
}

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Dashboard API  → http://localhost:${PORT}`);
  resumeInterrupted(listLeads());
  resumeSearches();
  resumeBuilds();
  resumeWp();
  startCareTimers();
});

// ---- Webhook receiver (the only thing to expose through the tunnel) ----
const hookApp = express();
hookApp.disable("x-powered-by");
hookApp.use(rawJson);
hookApp.use(express.urlencoded({ extended: true }));
hookApp.use("/hooks", hooks);
hookApp.get("/", (_req, res) => res.send("ok"));
// Localhost only: the tunnel connects from this PC, so nothing on the local network can reach it directly.
hookApp
  .listen(HOOK_PORT, "127.0.0.1", (err?: Error) => {
    if (!err) console.log(`Webhooks       → http://localhost:${HOOK_PORT}/hooks/elementor  and  /hooks/meta`);
  })
  // Another copy of the app (e.g. `npm run dev` next to the desktop app) already receives webhooks.
  .on("error", (e: NodeJS.ErrnoException) => console.warn(`Webhooks not started: port ${HOOK_PORT} ${e.code === "EADDRINUSE" ? "is in use by another copy of the app" : e.message}`));
