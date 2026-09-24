import { randomUUID } from "node:crypto";
import { sqlite as db } from "../db.ts";
import type { Campaign } from "../../shared/types.ts";

db.exec(`CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL);`);

export function createCampaign(input: { prompt: string; query: string; max: number; searchId: string }): Campaign {
  const c: Campaign = {
    id: randomUUID().slice(0, 8),
    prompt: input.prompt,
    query: input.query,
    max: input.max,
    status: "scraping",
    searchId: input.searchId,
    note: "Finding businesses…",
    createdAt: new Date().toISOString(),
    items: [],
  };
  db.prepare("INSERT INTO campaigns (id, created_at, data) VALUES (?, ?, ?)").run(c.id, c.createdAt, JSON.stringify(c));
  return c;
}

export const getCampaign = (id: string): Campaign | null => {
  const r = db.prepare("SELECT data FROM campaigns WHERE id = ?").get(id) as { data: string } | undefined;
  return r ? JSON.parse(r.data) : null;
};

export const listCampaigns = (): Campaign[] =>
  (db.prepare("SELECT data FROM campaigns ORDER BY created_at DESC").all() as { data: string }[]).map((r) => JSON.parse(r.data));

export const saveCampaign = (c: Campaign) => db.prepare("UPDATE campaigns SET data = ? WHERE id = ?").run(JSON.stringify(c), c.id);

export const deleteCampaign = (id: string) => db.prepare("DELETE FROM campaigns WHERE id = ?").run(id);

/** Read-modify-write guard so the pump and routes don't clobber each other. */
export function updateCampaign(id: string, fn: (c: Campaign) => void): Campaign | null {
  const c = getCampaign(id);
  if (!c) return null;
  fn(c);
  saveCampaign(c);
  return c;
}
