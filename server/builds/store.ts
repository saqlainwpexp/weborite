import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BUILDS_DIR, sqlite as db } from "../db.ts";
import { BUILD_STEPS, type Build, type BuildPage, type BuildStats } from "../../shared/types.ts";

db.exec(`CREATE TABLE IF NOT EXISTS builds (id TEXT PRIMARY KEY, lead_id TEXT, created_at TEXT NOT NULL, data TEXT NOT NULL);`);

export const buildDir = (id: string) => join(BUILDS_DIR, id);
export const siteDir = (id: string) => join(buildDir(id), "site");
export const partsDir = (id: string) => join(buildDir(id), "parts");

export function slugify(title: string, taken: Set<string>) {
  let base = title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page";
  if (base === "index" || base === "home") base = "index";
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  taken.add(slug);
  return slug;
}

export function makePages(input: { title: string; brief: string }[]): BuildPage[] {
  const taken = new Set<string>();
  const cleaned = input.map((p) => ({ title: p.title.trim(), brief: (p.brief ?? "").trim() })).filter((p) => p.title);
  // The homepage always exists and always comes first.
  const homeIdx = cleaned.findIndex((p) => /^home(page)?$/i.test(p.title));
  const home = homeIdx >= 0 ? cleaned.splice(homeIdx, 1)[0] : { title: "Home", brief: "The approved homepage" };
  return [home, ...cleaned].map((p, i) => ({
    slug: i === 0 ? (taken.add("index"), "index") : slugify(p.title, taken),
    title: p.title,
    brief: p.brief,
    status: "pending",
    attempts: 0,
    checks: [],
    pass: null,
  }));
}

export function createBuild(input: { leadId: string; business: string; url: string; homepageChanges: string; details: string; pages: BuildPage[] }): Build {
  const b: Build = {
    ...input,
    id: randomUUID().slice(0, 8),
    status: "draft",
    steps: BUILD_STEPS.map((s) => ({ key: s.key, status: "pending" })),
    linkCheck: null,
    createdAt: new Date().toISOString(),
  };
  db.prepare("INSERT INTO builds (id, lead_id, created_at, data) VALUES (?, ?, ?, ?)").run(b.id, b.leadId, b.createdAt, JSON.stringify(b));
  mkdirSync(partsDir(b.id), { recursive: true });
  mkdirSync(siteDir(b.id), { recursive: true });
  return b;
}

export function saveBuild(b: Build) {
  db.prepare("UPDATE builds SET data = ? WHERE id = ?").run(JSON.stringify(b), b.id);
}

export function getBuild(id: string): Build | null {
  const r = db.prepare("SELECT data FROM builds WHERE id = ?").get(id) as { data: string } | undefined;
  return r ? JSON.parse(r.data) : null;
}

export function listBuilds(): Build[] {
  return (db.prepare("SELECT data FROM builds ORDER BY created_at DESC").all() as { data: string }[]).map((r) => JSON.parse(r.data));
}

export function deleteBuildRow(id: string) {
  db.prepare("DELETE FROM builds WHERE id = ?").run(id);
}

export function buildStats(): BuildStats {
  const all = listBuilds();
  return {
    total: all.length,
    running: all.filter((b) => b.status === "queued" || b.status === "running").length,
    ready: all.filter((b) => b.status === "ready").length,
    pages: all.reduce((n, b) => n + b.pages.filter((p) => p.status === "done").length, 0),
  };
}
