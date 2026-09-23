import { randomUUID } from "node:crypto";
import { sqlite as db } from "../db.ts";
import type { FinderSearch, FinderStats, Prospect } from "../../shared/types.ts";

db.exec(`
  CREATE TABLE IF NOT EXISTS finder_searches (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS finder_prospects (
    id TEXT PRIMARY KEY, search_id TEXT NOT NULL, place_id TEXT UNIQUE, created_at TEXT NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS finder_prospects_search ON finder_prospects(search_id);
`);

const COLORS = ["#886fe2", "#e47053", "#4f9a6e", "#c98a2b", "#3f7cc9", "#c2508a", "#5a8f93", "#8a6d4f"];
const newId = () => randomUUID().slice(0, 8);

// ---- searches ----
export function createSearch(query: string, max: number): FinderSearch {
  const count = (db.prepare("SELECT COUNT(*) as n FROM finder_searches").get() as { n: number }).n;
  const s: FinderSearch = {
    id: newId(), query, source: "google_maps", max, status: "queued",
    found: 0, enriched: 0, withEmail: 0, withWhatsapp: 0,
    createdAt: new Date().toISOString(), color: COLORS[count % COLORS.length],
  };
  db.prepare("INSERT INTO finder_searches (id, created_at, data) VALUES (?, ?, ?)").run(s.id, s.createdAt, JSON.stringify(s));
  return s;
}

export function saveSearch(s: FinderSearch) {
  db.prepare("UPDATE finder_searches SET data = ? WHERE id = ?").run(JSON.stringify(s), s.id);
}

export function getSearch(id: string): FinderSearch | null {
  const r = db.prepare("SELECT data FROM finder_searches WHERE id = ?").get(id) as { data: string } | undefined;
  return r ? JSON.parse(r.data) : null;
}

export function listSearches(): FinderSearch[] {
  return (db.prepare("SELECT data FROM finder_searches ORDER BY created_at DESC").all() as { data: string }[]).map((r) => JSON.parse(r.data));
}

export function deleteSearch(id: string) {
  db.prepare("DELETE FROM finder_prospects WHERE search_id = ?").run(id);
  db.prepare("DELETE FROM finder_searches WHERE id = ?").run(id);
}

/** Recount a search's totals from its prospects. */
export function refreshSearchCounts(id: string) {
  const s = getSearch(id);
  if (!s) return null;
  const ps = listProspects({ searchId: id });
  s.found = ps.length;
  s.enriched = ps.filter((p) => p.enrichStatus === "done" || p.enrichStatus === "failed").length;
  s.withEmail = ps.filter((p) => p.tags.includes("email")).length;
  s.withWhatsapp = ps.filter((p) => p.tags.includes("whatsapp")).length;
  saveSearch(s);
  return s;
}

// ---- prospects ----
export function findByPlace(placeId: string): Prospect | null {
  const r = db.prepare("SELECT data FROM finder_prospects WHERE place_id = ?").get(placeId) as { data: string } | undefined;
  return r ? JSON.parse(r.data) : null;
}

export function insertProspect(p: Omit<Prospect, "id" | "createdAt">): Prospect {
  const full: Prospect = { ...p, id: newId(), createdAt: new Date().toISOString() };
  db.prepare("INSERT INTO finder_prospects (id, search_id, place_id, created_at, data) VALUES (?, ?, ?, ?, ?)").run(
    full.id, full.searchId, full.placeId, full.createdAt, JSON.stringify(full),
  );
  return full;
}

export function saveProspect(p: Prospect) {
  db.prepare("UPDATE finder_prospects SET data = ? WHERE id = ?").run(JSON.stringify(p), p.id);
}

export function getProspect(id: string): Prospect | null {
  const r = db.prepare("SELECT data FROM finder_prospects WHERE id = ?").get(id) as { data: string } | undefined;
  return r ? JSON.parse(r.data) : null;
}

export function listProspects(filter: { searchId?: string } = {}): Prospect[] {
  const rows = filter.searchId
    ? db.prepare("SELECT data FROM finder_prospects WHERE search_id = ? ORDER BY created_at DESC").all(filter.searchId)
    : db.prepare("SELECT data FROM finder_prospects ORDER BY created_at DESC").all();
  return (rows as { data: string }[]).map((r) => JSON.parse(r.data));
}

export function deleteProspect(id: string) {
  db.prepare("DELETE FROM finder_prospects WHERE id = ?").run(id);
}

export function finderStats(): FinderStats {
  const ps = listProspects();
  const ss = listSearches();
  return {
    total: ps.length,
    withEmail: ps.filter((p) => p.tags.includes("email")).length,
    withWhatsapp: ps.filter((p) => p.tags.includes("whatsapp")).length,
    withWebsite: ps.filter((p) => p.website).length,
    searches: ss.length,
    running: ss.filter((s) => s.status === "queued" || s.status === "searching" || s.status === "enriching").length,
  };
}

export function computeTags(p: Pick<Prospect, "emails" | "whatsapp" | "website">) {
  const tags: string[] = [];
  if (p.emails.length) tags.push("email");
  if (p.whatsapp === "business_profile" || p.whatsapp === "site_link") tags.push("whatsapp");
  tags.push(p.website ? "website" : "no-website");
  return tags;
}
