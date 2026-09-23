import { sqlite as db } from "../db.ts";
import type { BidderConfig, BidProject } from "../../shared/types.ts";

db.exec(`
  CREATE TABLE IF NOT EXISTS bidder_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS bidder_projects (id INTEGER PRIMARY KEY, found_at TEXT NOT NULL, status TEXT NOT NULL, bid_at TEXT, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS bidder_projects_found ON bidder_projects(found_at);
`);

type StoredConfig = Omit<BidderConfig, "tokenSet"> & { token: string };

const DEFAULTS: StoredConfig = {
  token: "",
  env: "sandbox",
  enabled: false,
  mode: "review",
  pollMinutes: 2,
  skills: [],
  query: "",
  exclude: [],
  types: { fixed: true, hourly: true },
  minFixedUsd: 30,
  minHourlyUsd: 10,
  maxBidCount: 40,
  maxAgeMinutes: 60,
  requirePaymentVerified: true,
  excludeCountries: [],
  dailyBidLimit: 10,
  floorPct: 50,
  ceilPct: 90,
  openBudgetFactor: 1.3,
  profile: "",
  samples: "",
  user: null,
};

// ---- config ----
export function getConfig(): StoredConfig {
  const rows = db.prepare("SELECT key, value FROM bidder_settings").all() as { key: string; value: string }[];
  const c: Record<string, unknown> = { ...DEFAULTS };
  for (const r of rows) c[r.key] = JSON.parse(r.value);
  return c as StoredConfig;
}

export function publicConfig(): BidderConfig {
  const { token, ...rest } = getConfig();
  return { ...rest, tokenSet: Boolean(token) };
}

export function setConfig(patch: Partial<StoredConfig>) {
  const stmt = db.prepare("INSERT INTO bidder_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [k, v] of Object.entries(patch)) if (v !== undefined && k in DEFAULTS) stmt.run(k, JSON.stringify(v));
}

// ---- projects ----
export function hasProject(id: number) {
  return Boolean(db.prepare("SELECT 1 FROM bidder_projects WHERE id = ?").get(id));
}

export function insertProject(p: BidProject) {
  db.prepare("INSERT OR IGNORE INTO bidder_projects (id, found_at, status, bid_at, data) VALUES (?, ?, ?, ?, ?)").run(p.id, p.foundAt, p.status, p.bidAt ?? null, JSON.stringify(p));
}

export function saveProject(p: BidProject) {
  db.prepare("UPDATE bidder_projects SET status = ?, bid_at = ?, data = ? WHERE id = ?").run(p.status, p.bidAt ?? null, JSON.stringify(p), p.id);
}

export function getProject(id: number): BidProject | null {
  const r = db.prepare("SELECT data FROM bidder_projects WHERE id = ?").get(id) as { data: string } | undefined;
  return r ? JSON.parse(r.data) : null;
}

export function listProjects(limit = 500): BidProject[] {
  return (db.prepare("SELECT data FROM bidder_projects ORDER BY found_at DESC LIMIT ?").all(limit) as { data: string }[]).map((r) => JSON.parse(r.data));
}

export function listByStatus(status: BidProject["status"]): BidProject[] {
  return (db.prepare("SELECT data FROM bidder_projects WHERE status = ? ORDER BY found_at ASC").all(status) as { data: string }[]).map((r) => JSON.parse(r.data));
}

export function deleteProject(id: number) {
  db.prepare("DELETE FROM bidder_projects WHERE id = ?").run(id);
}

export function bidsSince(iso: string) {
  return (db.prepare("SELECT COUNT(*) as n FROM bidder_projects WHERE status = 'bid' AND bid_at >= ?").get(iso) as { n: number }).n;
}

export function countBy() {
  const rows = db.prepare("SELECT status, COUNT(*) as n FROM bidder_projects GROUP BY status").all() as { status: string; n: number }[];
  const m = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<string, number>;
  return { total: rows.reduce((a, r) => a + r.n, 0), ...m };
}

export function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
