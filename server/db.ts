import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { STEPS, type EventItem, type FeedbackNote, type Lead, type Settings } from "../shared/types.ts";
import { initVault, isSealed, open, seal } from "./vault.ts";

// The desktop app passes its own folders; from the project folder these default to ./ and ./data.
export const ROOT = process.env.STUDIO_ROOT ?? resolve(import.meta.dirname, "..");
export const DATA = process.env.STUDIO_DATA ?? join(ROOT, "data");
export const LEADS_DIR = join(DATA, "leads");
export const BENCH_DIR = join(DATA, "benchmarks");
export const BRAND_DIR = join(DATA, "brand");
export const BUILDS_DIR = join(DATA, "builds");
export const API_PORT = Number(process.env.API_PORT ?? 4000);
for (const d of [DATA, LEADS_DIR, BENCH_DIR, BRAND_DIR, BUILDS_DIR]) mkdirSync(d, { recursive: true });
initVault(DATA);

const db = new DatabaseSync(join(DATA, "studio.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA secure_delete = ON;
  CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, url_key TEXT, email TEXT, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, lead_id TEXT, kind TEXT, title TEXT, detail TEXT);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, lead_id TEXT, mode TEXT, task TEXT, cost_usd REAL DEFAULT 0);
`);

/** Shared connection for other modules (Lead Finder keeps its own tables). */
export const sqlite = db;

export const leadDir = (id: string) => join(LEADS_DIR, id);

export function urlKey(url: string) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "");
  } catch {
    return url.trim().toLowerCase();
  }
}

export function normalizeUrl(raw: string) {
  let u = raw.trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return new URL(u).toString();
}

// ---- leads ----
export function listLeads(): Lead[] {
  const rows = db.prepare("SELECT data FROM leads ORDER BY created_at DESC").all() as { data: string }[];
  return rows.map((r) => JSON.parse(r.data));
}

export function getLead(id: string): Lead | null {
  const row = db.prepare("SELECT data FROM leads WHERE id = ?").get(id) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : null;
}

export function findDuplicate(url: string, email: string): Lead | null {
  const row = db
    .prepare("SELECT data FROM leads WHERE url_key = ? OR (email != '' AND email = ?) LIMIT 1")
    .get(urlKey(url), email.trim().toLowerCase()) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : null;
}

export function createLead(input: Omit<Lead, "id" | "createdAt" | "steps" | "status" | "vertical">): Lead {
  const lead: Lead = {
    ...input,
    id: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    vertical: null,
    status: "queued",
    steps: STEPS.map((s) => ({ key: s.key, status: "pending" })),
  };
  db.prepare("INSERT INTO leads (id, created_at, url_key, email, data) VALUES (?, ?, ?, ?, ?)").run(
    lead.id, lead.createdAt, urlKey(lead.url), lead.email.trim().toLowerCase(), JSON.stringify(lead),
  );
  mkdirSync(leadDir(lead.id), { recursive: true });
  return lead;
}

export function saveLead(lead: Lead) {
  db.prepare("UPDATE leads SET data = ? WHERE id = ?").run(JSON.stringify(lead), lead.id);
}

export function deleteLeadRow(id: string) {
  db.prepare("DELETE FROM leads WHERE id = ?").run(id);
}

// ---- per-lead JSON files ----
export function readJson<T>(id: string, file: string): T | null {
  const p = join(leadDir(id), file);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
}

export function writeJson(id: string, file: string, data: unknown) {
  writeFileSync(join(leadDir(id), file), JSON.stringify(data, null, 2));
}

// ---- learned feedback (global, cross-lead) ----
const FEEDBACK_FILE = join(DATA, "feedback-notes.json");
export function listFeedbackNotes(): FeedbackNote[] {
  try { return existsSync(FEEDBACK_FILE) ? (JSON.parse(readFileSync(FEEDBACK_FILE, "utf8")) as FeedbackNote[]) : []; } catch { return []; }
}
export function addFeedbackNote(n: Omit<FeedbackNote, "at">) {
  const text = n.text.trim();
  if (!text) return;
  const all = listFeedbackNotes();
  // Don't store the same note twice (e.g. re-saving unchanged feedback).
  if (all.some((x) => x.text === text && x.leadId === n.leadId && x.kind === n.kind)) return;
  all.push({ ...n, text, at: new Date().toISOString() });
  writeFileSync(FEEDBACK_FILE, JSON.stringify(all.slice(-300), null, 1));
}

// ---- events ----
export function addEvent(e: Omit<EventItem, "id" | "at">) {
  db.prepare("INSERT INTO events (at, lead_id, kind, title, detail) VALUES (?, ?, ?, ?, ?)").run(
    new Date().toISOString(), e.leadId, e.kind, e.title, e.detail,
  );
}

export function listEvents(limit = 30): EventItem[] {
  return (db.prepare("SELECT id, at, lead_id as leadId, kind, title, detail FROM events ORDER BY id DESC LIMIT ?").all(limit) as unknown) as EventItem[];
}

// ---- runs / usage ----
export function recordRun(leadId: string, mode: string, task: string, costUsd: number) {
  db.prepare("INSERT INTO runs (at, lead_id, mode, task, cost_usd) VALUES (?, ?, ?, ?, ?)").run(
    new Date().toISOString(), leadId, mode, task, costUsd,
  );
}

export function usageToday() {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const r = db
    .prepare("SELECT COUNT(DISTINCT lead_id) as jobs FROM runs WHERE at >= ?")
    .get(since.toISOString()) as { jobs: number };
  const month = new Date(since.getFullYear(), since.getMonth(), 1).toISOString();
  const c = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) as cost FROM runs WHERE mode = 'api' AND at >= ?").get(month) as { cost: number };
  return { jobsToday: r.jobs, apiCostUsd: c.cost };
}

// ---- settings ----
type StoredSettings = Settings & { apiKey: string; metaPageToken: string; metaAppSecret: string; psiKey: string; gtmetrixKey: string; cloudTriggerToken: string; githubToken: string; qaImapPassword: string; outreachSmtpPassword: string; openaiKey: string; geminiKey: string; openrouterKey: string; compatibleKey: string; hostingSftpPassword: string };

/** Settings that are stored encrypted (see vault.ts). */
const SECRET_KEYS = new Set(["apiKey", "metaPageToken", "metaAppSecret", "psiKey", "gtmetrixKey", "cloudTriggerToken", "githubToken", "qaImapPassword", "outreachSmtpPassword", "openaiKey", "geminiKey", "openrouterKey", "compatibleKey", "hostingSftpPassword"]);

const DEFAULTS: StoredSettings = {
  mode: "session",
  aiProvider: "claude",
  openaiAccess: "login",
  geminiAccess: "login",
  aiModels: {
    "openai-api": { heavy: "gpt-5", fast: "gpt-5-mini" },
    "openai-login": { heavy: "", fast: "" },
    "gemini-api": { heavy: "gemini-2.5-pro", fast: "gemini-2.5-flash" },
    "gemini-login": { heavy: "", fast: "" },
    openrouter: { heavy: "anthropic/claude-sonnet-4.5", fast: "google/gemini-2.5-flash" },
    compatible: { heavy: "", fast: "" },
    custom: { heavy: "", fast: "" },
  },
  openaiKey: "",
  openaiKeySet: false,
  geminiKey: "",
  geminiKeySet: false,
  openrouterKey: "",
  openrouterKeySet: false,
  compatibleKey: "",
  compatibleKeySet: false,
  compatibleBaseUrl: "",
  codexPath: "codex",
  geminiPath: "gemini",
  customCommand: "",
  parallelJobs: 3,
  parallelSearches: 2,
  apiKeySet: false,
  apiKey: "",
  generateModel: "claude-opus-5",
  fastModel: "claude-sonnet-5",
  elementorSecret: randomUUID().replace(/-/g, "").slice(0, 16),
  metaVerifyToken: randomUUID().replace(/-/g, "").slice(0, 16),
  metaPageToken: "",
  metaAppSecret: "",
  metaAppSecretSet: false,
  metaPageTokenSet: false,
  claudePath: "claude",
  cloudTriggerUrl: "",
  cloudTriggerToken: "",
  cloudTriggerTokenSet: false,
  githubToken: "",
  githubTokenSet: false,
  cloudRepo: "",
  cloudBranch: "claude/cloud-jobs",
  studioName: "Studio",
  brandColor: "#a36566",
  firstName: "",
  lastName: "",
  userName: "",
  userEmail: "",
  userPhone: "",
  role: "",
  companyDescription: "",
  niche: "",
  writingStyle: "",
  caseStudies: "",
  designContext: "",
  personalizationNotes: "",
  logoFile: "",
  psiKey: "",
  psiKeySet: false,
  gtmetrixKey: "",
  gtmetrixKeySet: false,
  qaEmail: "",
  agencyAdminEmail: "",
  qaImapHost: "",
  qaImapPort: 993,
  qaImapUser: "",
  qaImapPassword: "",
  qaImapPasswordSet: false,
  outreachFromName: "",
  outreachFromEmail: "",
  outreachSmtpHost: "",
  outreachSmtpPort: 465,
  outreachSmtpSecurity: "ssl",
  outreachSmtpUser: "",
  outreachSmtpPassword: "",
  outreachSmtpPasswordSet: false,
  outreachDailyCap: 40,
  outreachFooter: "If this isn't useful, reply “no thanks” and I won't email again.",
  outreachImapHost: "",
  outreachImapPort: 993,
  seoChecklist: [],
  avatarFile: "",
  careDay: 1,
  careAutoStage: true,
  careDiffThreshold: 1,
  careKeepStaging: false,
  hostingSftpHost: "",
  hostingSftpPort: 22,
  hostingSftpUser: "",
  hostingSftpPassword: "",
  hostingSftpPasswordSet: false,
  hostingBasePath: "",
  hostingPublicBaseUrl: "",
  autoPublishOnReady: false,
  currency: "USD",
};

export function getSettings(): StoredSettings {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const s: Record<string, unknown> = { ...DEFAULTS };
  for (const r of rows) s[r.key] = SECRET_KEYS.has(r.key) ? open(JSON.parse(r.value)) : JSON.parse(r.value);
  if (process.env.ANTHROPIC_API_KEY && !s.apiKey) s.apiKey = process.env.ANTHROPIC_API_KEY;
  s.apiKeySet = Boolean(s.apiKey);
  s.metaPageTokenSet = Boolean(s.metaPageToken);
  s.metaAppSecretSet = Boolean(s.metaAppSecret);
  s.psiKeySet = Boolean(s.psiKey);
  s.gtmetrixKeySet = Boolean(s.gtmetrixKey);
  s.cloudTriggerTokenSet = Boolean(s.cloudTriggerToken);
  s.githubTokenSet = Boolean(s.githubToken);
  s.qaImapPasswordSet = Boolean(s.qaImapPassword);
  s.outreachSmtpPasswordSet = Boolean(s.outreachSmtpPassword);
  s.hostingSftpPasswordSet = Boolean(s.hostingSftpPassword);
  s.openaiKeySet = Boolean(s.openaiKey);
  s.geminiKeySet = Boolean(s.geminiKey);
  s.openrouterKeySet = Boolean(s.openrouterKey);
  s.compatibleKeySet = Boolean(s.compatibleKey);
  // Saved model lists from older versions miss newer providers: fill them from the defaults.
  s.aiModels = { ...DEFAULTS.aiModels, ...((s.aiModels as object) ?? {}) };
  // Older installs stored a single full name.
  if (!s.firstName && !s.lastName && s.userName) [s.firstName, s.lastName] = [String(s.userName).split(" ")[0], String(s.userName).split(" ").slice(1).join(" ")];
  s.userName = [s.firstName, s.lastName].filter(Boolean).join(" ") || "Studio Owner";
  // Persist generated secrets on first read so webhook URLs stay stable.
  if (!rows.find((r) => r.key === "elementorSecret")) setSettings({ elementorSecret: s.elementorSecret, metaVerifyToken: s.metaVerifyToken } as Partial<StoredSettings>);
  return s as unknown as StoredSettings;
}

export function publicSettings(): Settings {
  const { apiKey: _k, metaPageToken: _t, metaAppSecret: _s, psiKey: _p, gtmetrixKey: _g, cloudTriggerToken: _c, githubToken: _h, qaImapPassword: _ip, outreachSmtpPassword: _op, openaiKey: _ok, geminiKey: _gk, openrouterKey: _rk, compatibleKey: _ck, hostingSftpPassword: _hp, ...rest } = getSettings();
  return rest;
}

export function setSettings(patch: Partial<StoredSettings>) {
  const stmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [k, v] of Object.entries(patch)) {
    if (k.endsWith("Set") || k === "userName" || v === undefined) continue;
    stmt.run(k, JSON.stringify(SECRET_KEYS.has(k) && typeof v === "string" ? seal(v) : v));
  }
}

/**
 * The agency's own profile, formatted for an AI prompt: who they are, their niche, voice, past work and goals.
 * Collected at onboarding and editable in Settings → Profile. Returns "" when nothing useful is set, so callers
 * can append it unconditionally. `focus` keeps the block relevant: "design" for mockups, "writing" for outreach.
 */
export function agencyProfileBlock(focus: "design" | "writing" = "design"): string {
  const s = getSettings();
  const clip = (v: string, max = 600) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const rows: [string, string][] = [
    ["Agency / company", clip([s.studioName === "Studio" ? "" : s.studioName, s.role].filter(Boolean).join(" — "), 160)],
    ["About the business", clip(s.companyDescription)],
    ["Niche / ideal clients", clip(s.niche)],
    ["Past work & results", clip(s.caseStudies)],
    ["Design background, mission & goals", clip(s.designContext)],
  ];
  if (focus === "writing") {
    rows.push(["How the agency writes (voice, examples)", clip(s.writingStyle, 1200)]);
  }
  rows.push(["Other personalization notes", clip(s.personalizationNotes)]);
  const lines = rows.filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`);
  if (!lines.length) return "";
  const intro = focus === "writing"
    ? "ABOUT THE AGENCY SENDING THIS — match their voice and draw on their real background. Never invent results or clients not listed here:"
    : "ABOUT THE AGENCY BEHIND THIS MOCKUP — reflect their taste, niche and goals where it helps the design:";
  return `\n\n${intro}\n${lines.join("\n")}`;
}


/**
 * One-time upgrade: encrypt secrets saved before encryption existed. Runs at startup once every
 * module has created its tables; already encrypted values are left alone, so it's safe to repeat.
 */
export function encryptStoredSecrets() {
  let n = 0;
  for (const r of db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[]) {
    const v = JSON.parse(r.value);
    if (SECRET_KEYS.has(r.key) && typeof v === "string" && v && !isSealed(v)) {
      db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(seal(v)), r.key);
      n++;
    }
  }
  for (const table of ["wp_conversions", "seo_sites", "care_sites"]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
    for (const r of db.prepare(`SELECT id, secret FROM ${table} WHERE secret != ''`).all() as { id: string; secret: string }[]) {
      if (isSealed(r.secret)) continue;
      db.prepare(`UPDATE ${table} SET secret = ? WHERE id = ?`).run(seal(r.secret), r.id);
      n++;
    }
  }
  if (!n) return;
  // Rewrite the file so no copy of the old plaintext survives in free pages or the write-ahead log.
  db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
  console.log(`Encrypted ${n} saved password${n === 1 ? "" : "s"}, keys and tokens with Windows encryption`);
}
