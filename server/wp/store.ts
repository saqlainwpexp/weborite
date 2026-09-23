import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA, sqlite as db } from "../db.ts";
import { open, seal } from "../vault.ts";
import type { Build, WpConversion } from "../../shared/types.ts";

db.exec(`CREATE TABLE IF NOT EXISTS wp_conversions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, secret TEXT NOT NULL DEFAULT '', preview_token TEXT NOT NULL, data TEXT NOT NULL);`);

export const WP_DIR = join(DATA, "wp");
export const convDir = (id: string) => join(WP_DIR, id);

export function createConversion(build: Build, input: { siteUrl: string; wpUser: string; appPassword: string; elementorPro: boolean }): WpConversion {
  const c: WpConversion = {
    id: randomUUID().slice(0, 8),
    buildId: build.id,
    business: build.business,
    siteUrl: input.siteUrl.replace(/\/$/, ""),
    wpUser: input.wpUser,
    appPasswordSet: Boolean(input.appPassword),
    elementorPro: input.elementorPro,
    status: "setup",
    connected: null,
    pages: build.pages.map((p) => ({ slug: p.slug, title: p.title, status: "pending", sections: [], wpPageId: null, wpUrl: "", previewUrl: "", diff: null })),
    customWidgets: [],
    pluginVersion: 1,
    createdAt: new Date().toISOString(),
  };
  db.prepare("INSERT INTO wp_conversions (id, created_at, secret, preview_token, data) VALUES (?, ?, ?, ?, ?)").run(
    c.id, c.createdAt, seal(input.appPassword), randomBytes(16).toString("hex"), JSON.stringify(c),
  );
  mkdirSync(convDir(c.id), { recursive: true });
  return c;
}

export function saveConversion(c: WpConversion) {
  db.prepare("UPDATE wp_conversions SET data = ? WHERE id = ?").run(JSON.stringify(c), c.id);
}

export function getConversion(id: string): WpConversion | null {
  const r = db.prepare("SELECT data FROM wp_conversions WHERE id = ?").get(id) as { data: string } | undefined;
  return r ? JSON.parse(r.data) : null;
}

export function getSecrets(id: string) {
  const r = db.prepare("SELECT secret, preview_token as previewToken FROM wp_conversions WHERE id = ?").get(id) as { secret: string; previewToken: string };
  return r && { ...r, secret: open(r.secret) };
}

export function setSecret(id: string, appPassword: string) {
  db.prepare("UPDATE wp_conversions SET secret = ? WHERE id = ?").run(seal(appPassword), id);
}

export function listConversions(): WpConversion[] {
  return (db.prepare("SELECT data FROM wp_conversions ORDER BY created_at DESC").all() as { data: string }[]).map((r) => JSON.parse(r.data));
}

export function deleteConversionRow(id: string) {
  db.prepare("DELETE FROM wp_conversions WHERE id = ?").run(id);
}
