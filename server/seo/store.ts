import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, sqlite as db } from "../db.ts";
import { open, seal } from "../vault.ts";
import type { SeoSite } from "../../shared/types.ts";

db.exec(`CREATE TABLE IF NOT EXISTS seo_sites (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, secret TEXT NOT NULL DEFAULT '', preview_token TEXT NOT NULL, data TEXT NOT NULL);`);

export const SEO_DIR = join(DATA, "seo");
export const siteDataDir = (id: string) => join(SEO_DIR, id);

export function createSite(input: { name: string; siteUrl: string; conversionId: string | null; wpUser: string; appPassword: string }): SeoSite {
  const s: SeoSite = {
    id: randomUUID().slice(0, 8),
    name: input.name,
    siteUrl: input.siteUrl.replace(/\/$/, ""),
    conversionId: input.conversionId,
    wpUser: input.wpUser,
    appPasswordSet: Boolean(input.appPassword),
    connected: null,
    pages: [],
    runs: {},
    qaSignedOff: false,
    createdAt: new Date().toISOString(),
  };
  db.prepare("INSERT INTO seo_sites (id, created_at, secret, preview_token, data) VALUES (?, ?, ?, ?, ?)").run(
    s.id, s.createdAt, seal(input.appPassword), randomBytes(16).toString("hex"), JSON.stringify(s),
  );
  mkdirSync(siteDataDir(s.id), { recursive: true });
  return s;
}

export function saveSite(s: SeoSite) {
  db.prepare("UPDATE seo_sites SET data = ? WHERE id = ?").run(JSON.stringify(s), s.id);
}

export function getSite(id: string): SeoSite | null {
  const r = db.prepare("SELECT data FROM seo_sites WHERE id = ?").get(id) as { data: string } | undefined;
  return r ? JSON.parse(r.data) : null;
}

export function listSites(): SeoSite[] {
  return (db.prepare("SELECT data FROM seo_sites ORDER BY created_at DESC").all() as { data: string }[]).map((r) => JSON.parse(r.data));
}

export function siteSecrets(id: string) {
  const r = db.prepare("SELECT secret, preview_token as previewToken FROM seo_sites WHERE id = ?").get(id) as { secret: string; previewToken: string };
  return r && { ...r, secret: open(r.secret) };
}

export function setSiteSecret(id: string, secret: string) {
  db.prepare("UPDATE seo_sites SET secret = ? WHERE id = ?").run(seal(secret), id);
}

export function deleteSiteRow(id: string) {
  db.prepare("DELETE FROM seo_sites WHERE id = ?").run(id);
}

export function readResult<T>(id: string, name: string): T | null {
  const p = join(siteDataDir(id), `${name}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
}

export function writeResult(id: string, name: string, data: unknown) {
  mkdirSync(siteDataDir(id), { recursive: true });
  writeFileSync(join(siteDataDir(id), `${name}.json`), JSON.stringify(data, null, 1));
}
