import express, { type Request } from "express";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec } from "node:child_process";
// @ts-expect-error archiver v8 ships without type declarations
import { ZipArchive } from "archiver";
import {
  API_PORT, BRAND_DIR, BUILDS_DIR, LEADS_DIR, ROOT, addFeedbackNote, deleteLeadRow, encryptStoredSecrets, getLead, getSettings, leadDir, listEvents, listLeads,
  normalizeUrl, publicSettings, readJson, saveLead, setSettings, usageToday,
} from "./db.ts";
import { enqueue, queueState, resumeInterrupted, stopLead } from "./queue.ts";
import { hooks, intakeLead } from "./intake.ts";
import { getBenchmarkSet, listBenchmarkSets, saveBenchmarkSet } from "./pipeline/benchmarks.ts";
import { finder } from "./finder/routes.ts";
import { meta as metaLeads } from "./finder/metaRoutes.ts";
import { resumeSearches } from "./finder/queue.ts";
import { builds } from "./builds/routes.ts";
import { listBuilds } from "./builds/store.ts";
import { resumeBuilds } from "./builds/queue.ts";
import { resumeWp, wp } from "./wp/routes.ts";
import { WP_DIR, listConversions } from "./wp/store.ts";
import { seo } from "./seo/routes.ts";
import { golive } from "./golive/routes.ts";
import { SEO_DIR } from "./seo/store.ts";
import { care, startCareTimers } from "./care/routes.ts";
import { comms } from "./comms.ts";
import { admin } from "./admin.ts";
import { agent } from "./agent/routes.ts";
import { campaigns, startCampaignTimers } from "./campaigns/index.ts";
import { automations } from "./automations/routes.ts";
import { mockupPreview, outreach, outreachReady, startWorkflowTimers } from "./automations/engine.ts";
import { sendMail } from "./golive/smtp.ts";
import { license, requireFullLicense, requireLicense, startLicenseTimers } from "./license/index.ts";
import { assertPublicUrl, localOnly, sandboxFiles } from "./security.ts";
import { STEPS, type BenchmarkSet, type Capture, type Diagnosis, type GateResult, type Lead, type LeadDetail, type LeadPlaybook, type OutreachEmail, type StepKey, type Usage } from "../shared/types.ts";
import { ai } from "./claude/aiRoutes.ts";
import { pitch } from "./pitch.ts";
import { playbook } from "./playbook.ts";
import { hostingReady, publishMockup, unpublishMockup } from "./publish/hostinger.ts";

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
// Gate the API for unlicensed installs; the license routes themselves stay reachable.
app.use("/api/license", license);
app.use(requireLicense(/^\/api\/license\//));

app.get("/api/leads", (_req, res) => res.json(listLeads()));

app.get("/api/leads/:id", (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.sendStatus(404);
  // The build and WordPress conversion made from this lead, so the UI can show "advance to next step".
  const build = listBuilds().find((b) => b.leadId === lead.id) ?? null;
  const conversion = build ? listConversions().find((c) => c.buildId === build.id) ?? null : null;
  const detail: LeadDetail = {
    ...lead,
    capture: readJson<Capture>(lead.id, "capture.json"),
    diagnosis: readJson<Diagnosis>(lead.id, "diagnosis.json"),
    gate: readJson<GateResult>(lead.id, "gate.json"),
    benchmarks: lead.vertical ? getBenchmarkSet(lead.vertical) : null,
    hasMockup: existsSync(join(leadDir(lead.id), "mockup", "index.html")),
    hasSideBySide: existsSync(join(leadDir(lead.id), "side-by-side.png")),
    outreach: readJson<OutreachEmail>(lead.id, "outreach.json"),
    playbook: readJson<LeadPlaybook>(lead.id, "playbook.json"),
    publishReady: hostingReady(),
    emailReady: outreachReady(),
    pipeline: {
      build: build ? { id: build.id, status: build.status } : null,
      conversion: conversion ? { id: conversion.id, status: conversion.status } : null,
    },
  };
  res.json(detail);
});

/** Save free-text CRM notes on a lead. */
app.post("/api/leads/:id/notes", (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.sendStatus(404);
  lead.notes = String((req.body ?? {}).notes ?? "").slice(0, 8000);
  saveLead(lead);
  res.json({ ok: true, notes: lead.notes });
});

/** Stamp the lead as contacted and prepend a dated line to its CRM notes (recent-first). */
function logContact(lead: Lead, line: string) {
  lead.lastContactedAt = new Date().toISOString();
  const entry = `• ${lead.lastContactedAt.slice(0, 10)}: ${line}`;
  lead.notes = (entry + (lead.notes ? `\n${lead.notes}` : "")).slice(0, 8000);
}

/** Send an outreach email to this lead from the configured outreach mailbox (Settings → Integrations). */
app.post("/api/leads/:id/send-email", async (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.sendStatus(404);
  const b = req.body ?? {};
  const subject = String(b.subject ?? "").trim();
  const body = String(b.body ?? "").trim();
  if (!subject || !body) return res.status(400).json({ error: "Add a subject and a message before sending." });
  const o = outreach();
  if (!outreachReady(o)) return res.status(400).json({ error: "Set up your outreach mailbox in Settings → Integrations first." });
  // A test goes to your own outreach address and is NOT logged against the lead.
  const test = Boolean(b.test);
  const to = (test ? o.fromEmail : String(b.to || lead.email || "")).trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: test ? "Your outreach address isn't set." : "This lead has no valid email address." });
  let attachment: { name: string; type: string; data: Buffer } | undefined;
  if (b.attachMockup) {
    const img = await mockupPreview(lead.id).catch(() => null);
    if (img) attachment = { name: `${(lead.business || "mockup").replace(/[^\w-]+/g, "-").slice(0, 40)}-new-website.jpg`, type: "image/jpeg", data: img };
  }
  try {
    await sendMail(
      { host: o.host, port: o.port, security: o.security, user: o.user, password: o.password },
      { fromName: o.fromName, fromEmail: o.fromEmail, to, subject: test ? `[TEST] ${subject}` : subject, text: body + (o.footer ? `\n\n${o.footer}` : ""), attachment },
    );
    if (!test) { logContact(lead, `Emailed — ${subject.slice(0, 120)}`); saveLead(lead); }
    res.json({ ok: true, lastContactedAt: lead.lastContactedAt, notes: lead.notes });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

/** Record a non-email contact (WhatsApp opened, call placed) so the CRM tracks outreach history. */
app.post("/api/leads/:id/contacted", (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.sendStatus(404);
  const channel = String((req.body ?? {}).channel ?? "");
  const line = channel === "whatsapp" ? "Messaged on WhatsApp" : channel === "call" ? "Called" : channel === "email" ? "Emailed" : "Contacted";
  logContact(lead, line);
  saveLead(lead);
  res.json({ ok: true, lastContactedAt: lead.lastContactedAt, notes: lead.notes });
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

app.post("/api/leads/:id/stop", (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.sendStatus(404);
  stopLead(lead.id);
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

// A unique, filesystem-safe folder name for a lead inside a combined export / on the live host.
function leadSlug(lead: { url: string; business?: string; id: string }) {
  const base = (() => { try { return new URL(lead.url).hostname.replace(/^www\./, ""); } catch { return lead.business || "lead"; } })();
  return `${base.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "lead"}-${lead.id.slice(0, 6)}`;
}

// ---- Bulk actions on the Leads table ----
app.post("/api/leads/bulk", (req, res) => {
  const { ids, action } = (req.body ?? {}) as { ids?: unknown; action?: string };
  const list = Array.isArray(ids) ? ids.map(String) : [];
  if (!list.length || action !== "delete") return res.status(400).json({ error: "Pass ids and a supported action" });
  let done = 0;
  for (const id of list) {
    if (!getLead(id)) continue;
    deleteLeadRow(id);
    rmSync(leadDir(id), { recursive: true, force: true });
    done++;
  }
  res.json({ ok: true, deleted: done });
});

app.patch("/api/leads/bulk", (req, res) => {
  const { ids, patch } = (req.body ?? {}) as { ids?: unknown; patch?: Record<string, unknown> };
  const list = Array.isArray(ids) ? ids.map(String) : [];
  const allowed = ["business", "email", "phone"] as const;
  const clean: Partial<Record<(typeof allowed)[number], string>> = {};
  for (const k of allowed) if (typeof patch?.[k] === "string" && (patch[k] as string).trim()) clean[k] = (patch[k] as string).trim();
  if (!list.length || !Object.keys(clean).length) return res.status(400).json({ error: "Pass ids and at least one field to change" });
  let done = 0;
  for (const id of list) {
    const lead = getLead(id);
    if (!lead) continue;
    Object.assign(lead, clean);
    saveLead(lead);
    done++;
  }
  res.json({ ok: true, updated: done });
});

app.post("/api/leads/export", (req, res) => {
  const list = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map(String) : [];
  const leads = list.map((id) => getLead(id)).filter((l): l is NonNullable<typeof l> => Boolean(l && existsSync(join(leadDir(l.id), "mockup", "index.html"))));
  if (!leads.length) return res.status(404).json({ error: "None of the selected leads have a generated mockup" });
  res.attachment(`mockups-${new Date().toISOString().slice(0, 10)}.zip`);
  const zip = new ZipArchive({ zlib: { level: 6 } });
  zip.pipe(res);
  for (const lead of leads) {
    const dir = leadDir(lead.id);
    const folder = leadSlug(lead);
    zip.directory(join(dir, "mockup"), `${folder}/mockup`);
    if (existsSync(join(dir, "assets"))) zip.directory(join(dir, "assets"), `${folder}/assets`);
    if (existsSync(join(dir, "side-by-side.png"))) zip.file(join(dir, "side-by-side.png"), { name: `${folder}/side-by-side.png` });
  }
  void zip.finalize();
});

// ---- Rating / feedback / change requests on one mockup ----
app.post("/api/leads/:id/feedback", (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.sendStatus(404);
  const { rating, feedback } = (req.body ?? {}) as { rating?: unknown; feedback?: unknown };
  if (rating !== undefined && rating !== null) {
    const n = Number(rating);
    if (!Number.isNaN(n)) lead.rating = Math.max(0, Math.min(10, Math.round(n)));
  }
  if (typeof feedback === "string") {
    lead.feedback = feedback.slice(0, 2000);
    // Remember the comment so future mockups honour it without being told again.
    if (lead.feedback.trim()) addFeedbackNote({ leadId: lead.id, vertical: lead.vertical ?? null, kind: "feedback", text: lead.feedback });
  }
  saveLead(lead);
  res.json({ ok: true, rating: lead.rating, feedback: lead.feedback });
});

app.post("/api/leads/:id/revise", (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.sendStatus(404);
  const text = String((req.body ?? {}).text ?? "").trim();
  if (!text) return res.status(400).json({ error: "Describe the change you want" });
  if (!existsSync(join(leadDir(lead.id), "mockup", "index.html"))) return res.status(400).json({ error: "There's no mockup to revise yet" });
  lead.reviseRequest = text.slice(0, 2000);
  // A change request is also a lasting preference: carry it to future mockups.
  addFeedbackNote({ leadId: lead.id, vertical: lead.vertical ?? null, kind: "change", text: lead.reviseRequest });
  // Re-run from the generate step so the change is applied, then re-gated and re-rendered.
  const idx = STEPS.findIndex((s) => s.key === "generate");
  lead.steps.forEach((s, i) => { if (i >= idx) Object.assign(s, { status: "pending", note: undefined, startedAt: undefined, finishedAt: undefined }); });
  saveLead(lead);
  enqueue(lead.id);
  res.json({ ok: true });
});

// ---- Publish a mockup live (Hostinger over SFTP) ----
app.get("/api/leads/:id/publish", (_req, res) => res.json({ ready: hostingReady() }));

app.post("/api/leads/:id/publish", async (req, res) => {
  if (!getLead(req.params.id)) return res.sendStatus(404);
  try {
    res.json(await publishMockup(req.params.id));
  } catch (e) {
    res.status(502).json({ error: (e as Error).message || "Couldn't publish the mockup" });
  }
});

app.delete("/api/leads/:id/publish", async (req, res) => {
  if (!getLead(req.params.id)) return res.sendStatus(404);
  try {
    await unpublishMockup(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message || "Couldn't unpublish the mockup" });
  }
});

app.use("/api/finder", finder);
app.use("/api/meta", metaLeads);
app.use("/api/builds", builds);
app.use("/api/wp", wp);
app.use("/api/seo", seo);
app.use("/api/golive", golive);
app.use("/api/care", care);
app.use("/api/comms", comms);
app.use("/api/admin", admin);
app.use("/api/agent", agent);
app.use("/api/campaigns", campaigns);
app.use("/api/automations", automations);

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
    "cloudTriggerUrl", "cloudTriggerToken", "githubToken", "cloudRepo", "cloudBranch",
    "studioName", "brandColor", "firstName", "lastName", "userEmail", "userPhone",
    "psiKey", "gtmetrixKey", "qaEmail", "agencyAdminEmail", "qaImapHost", "qaImapUser", "qaImapPassword",
    "outreachFromName", "outreachFromEmail", "outreachSmtpHost", "outreachSmtpUser", "outreachSmtpPassword", "outreachFooter", "outreachImapHost",
    "openaiKey", "geminiKey", "openrouterKey", "compatibleKey", "compatibleBaseUrl", "codexPath", "geminiPath", "customCommand",
    "hostingSftpHost", "hostingSftpUser", "hostingSftpPassword", "hostingBasePath", "hostingPublicBaseUrl",
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
  if (body.outreachSmtpPort !== undefined) extra.outreachSmtpPort = Math.max(1, Math.min(65535, Math.round(Number(body.outreachSmtpPort)) || 465));
  if (body.outreachSmtpSecurity !== undefined) extra.outreachSmtpSecurity = ["ssl", "tls", "none"].includes(body.outreachSmtpSecurity) ? body.outreachSmtpSecurity : "ssl";
  if (["claude", "openai", "gemini", "openrouter", "compatible", "custom"].includes(body.aiProvider)) extra.aiProvider = body.aiProvider;
  if (["login", "api"].includes(body.openaiAccess)) extra.openaiAccess = body.openaiAccess;
  if (["login", "api"].includes(body.geminiAccess)) extra.geminiAccess = body.geminiAccess;
  if (body.aiModels && typeof body.aiModels === "object") {
    const cur = getSettings().aiModels as Record<string, { heavy: string; fast: string }>;
    for (const [k, m] of Object.entries(body.aiModels as Record<string, { heavy?: unknown; fast?: unknown }>)) {
      if (k in cur && m && typeof m === "object") cur[k] = { heavy: String(m.heavy ?? cur[k].heavy).trim().slice(0, 120), fast: String(m.fast ?? cur[k].fast).trim().slice(0, 120) };
    }
    extra.aiModels = cur;
  }
  if (body.parallelJobs !== undefined) extra.parallelJobs = Math.max(1, Math.min(8, Math.round(Number(body.parallelJobs)) || 3));
  if (body.parallelSearches !== undefined) extra.parallelSearches = Math.max(1, Math.min(4, Math.round(Number(body.parallelSearches)) || 2));
  if (body.outreachImapPort !== undefined) extra.outreachImapPort = Math.max(1, Math.min(65535, Math.round(Number(body.outreachImapPort)) || 993));
  if (body.outreachDailyCap !== undefined) extra.outreachDailyCap = Math.max(1, Math.min(500, Math.round(Number(body.outreachDailyCap)) || 40));
  if (body.qaImapPort !== undefined) extra.qaImapPort = Math.max(1, Math.min(65535, Math.round(Number(body.qaImapPort)) || 993));
  if (body.careDay !== undefined) extra.careDay = Math.max(0, Math.min(28, Math.round(Number(body.careDay)) || 0));
  if (body.careDiffThreshold !== undefined) extra.careDiffThreshold = Math.max(0.1, Math.min(20, Number(body.careDiffThreshold) || 1));
  if (typeof body.careAutoStage === "boolean") extra.careAutoStage = body.careAutoStage;
  if (typeof body.careKeepStaging === "boolean") extra.careKeepStaging = body.careKeepStaging;
  if (body.hostingSftpPort !== undefined) extra.hostingSftpPort = Math.max(1, Math.min(65535, Math.round(Number(body.hostingSftpPort)) || 22));
  if (typeof body.autoPublishOnReady === "boolean") extra.autoPublishOnReady = body.autoPublishOnReady;
  if ("brandColor" in patch && !/^#[0-9a-f]{6}$/i.test(patch.brandColor as string)) return res.status(400).json({ error: "Brand colour must be a 6-digit hex like #a36566" });
  // CLI paths are run through the shell on Windows (and interpolated into the sign-in terminal command),
  // so they must be plain paths — no shell metacharacters. Empty is allowed (falls back to the default name).
  for (const k of ["claudePath", "codexPath", "geminiPath"] as const) {
    if (k in patch && /[&|<>^%!"`$;\r\n]/.test(String(patch[k]))) return res.status(400).json({ error: "CLI paths must be a plain file path or command name" });
  }
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

app.use("/api/ai", ai);
app.use("/api/pitch", pitch);
app.use("/api/playbook", playbook);

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
// Brand assets are only ever shown as images. Override the permissive mockup CSP with a bare `sandbox`
// (no allow-scripts) so an uploaded SVG can't run script if opened directly as a page.
app.use("/files/brand", (_req, res, next) => { res.set("Content-Security-Policy", "sandbox"); next(); });
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

app
  .listen(PORT, "127.0.0.1", () => {
    console.log(`Dashboard API  → http://localhost:${PORT}`);
    resumeInterrupted(listLeads());
    resumeSearches();
    resumeBuilds();
    resumeWp();
    startCareTimers();
    startCampaignTimers();
    startWorkflowTimers();
    startLicenseTimers();
  })
  // Without this, a clash on the API port throws an unhandled error and the whole server dies, so the
  // dashboard shows "Failed to fetch" for everything. Report it clearly and stop instead.
  .on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") console.error(`\nAPI port ${PORT} is already in use — another copy of the app is running, or a previous one didn't shut down.\nClose it (or set API_PORT to a free port), then start again.\n`);
    else console.error(`The dashboard API couldn't start: ${e.message}`);
    process.exit(1);
  });

// ---- Webhook receiver (the only thing to expose through the tunnel) ----
const hookApp = express();
hookApp.disable("x-powered-by");
hookApp.use(rawJson);
hookApp.use(express.urlencoded({ extended: true }));
hookApp.use("/hooks", requireFullLicense, hooks);
hookApp.get("/", (_req, res) => res.send("ok"));
// Localhost only: the tunnel connects from this PC, so nothing on the local network can reach it directly.
hookApp
  .listen(HOOK_PORT, "127.0.0.1", (err?: Error) => {
    if (!err) console.log(`Webhooks       → http://localhost:${HOOK_PORT}/hooks/elementor  and  /hooks/meta`);
  })
  // Another copy of the app (e.g. `npm run dev` next to the desktop app) already receives webhooks.
  .on("error", (e: NodeJS.ErrnoException) => console.warn(`Webhooks not started: port ${HOOK_PORT} ${e.code === "EADDRINUSE" ? "is in use by another copy of the app" : e.message}`));
