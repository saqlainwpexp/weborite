import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA, sqlite as db } from "../db.ts";
import { open, seal } from "../vault.ts";
import type { CareSite } from "../../shared/types.ts";

db.exec(`CREATE TABLE IF NOT EXISTS care_sites (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, secret TEXT NOT NULL DEFAULT '', data TEXT NOT NULL);`);

export const CARE_DIR = join(DATA, "care");
export const careDir = (id: string) => join(CARE_DIR, id);

export function createCareSite(input: { name: string; siteUrl: string; wpUser: string; appPassword: string; client: string; seoSiteId: string | null }): CareSite {
  const s: CareSite = {
    id: randomUUID().slice(0, 8),
    name: input.name,
    siteUrl: input.siteUrl.replace(/\/$/, ""),
    wpUser: input.wpUser,
    appPasswordSet: Boolean(input.appPassword),
    seoSiteId: input.seoSiteId,
    client: input.client,
    connected: null,
    summary: null,
    job: null,
    run: null,
    history: [],
    lastScan: null,
    createdAt: new Date().toISOString(),
  };
  db.prepare("INSERT INTO care_sites (id, created_at, secret, data) VALUES (?, ?, ?, ?)").run(s.id, s.createdAt, seal(input.appPassword), JSON.stringify(s));
  mkdirSync(careDir(s.id), { recursive: true });
  return s;
}

export function saveCareSite(s: CareSite) {
  db.prepare("UPDATE care_sites SET data = ? WHERE id = ?").run(JSON.stringify(s), s.id);
}

export function getCareSite(id: string): CareSite | null {
  const r = db.prepare("SELECT data FROM care_sites WHERE id = ?").get(id) as { data: string } | undefined;
  return r ? JSON.parse(r.data) : null;
}

export function listCareSites(): CareSite[] {
  return (db.prepare("SELECT data FROM care_sites ORDER BY created_at DESC").all() as { data: string }[]).map((r) => JSON.parse(r.data));
}

/** Read-modify-write so concurrent progress notes don't clobber each other. */
export function updateCareSite(id: string, fn: (s: CareSite) => void) {
  const s = getCareSite(id);
  if (!s) return null;
  fn(s);
  saveCareSite(s);
  return s;
}

export const careSecret = (id: string) => open((db.prepare("SELECT secret FROM care_sites WHERE id = ?").get(id) as { secret: string } | undefined)?.secret ?? "");
export const setCareSecret = (id: string, secret: string) => db.prepare("UPDATE care_sites SET secret = ? WHERE id = ?").run(seal(secret), id);
export const deleteCareRow = (id: string) => db.prepare("DELETE FROM care_sites WHERE id = ?").run(id);

export function readCare<T>(id: string, name: string): T | null {
  const p = join(careDir(id), `${name}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
}

export function writeCare(id: string, name: string, data: unknown) {
  const file = join(careDir(id), `${name}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 1));
}
