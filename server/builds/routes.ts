import { Router } from "express";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getLead, leadDir } from "../db.ts";
import { BUILD_STEPS } from "../../shared/types.ts";
import { enqueueBuild } from "./queue.ts";
import { buildDir, buildStats, createBuild, deleteBuildRow, getBuild, listBuilds, makePages, saveBuild } from "./store.ts";

export const builds = Router();

const cleanPages = (raw: unknown) =>
  Array.isArray(raw) ? raw.map((p) => ({ title: String(p?.title ?? ""), brief: String(p?.brief ?? "") })).filter((p) => p.title.trim()) : [];

builds.get("/stats", (_req, res) => res.json(buildStats()));
builds.get("/", (_req, res) => res.json(listBuilds()));

builds.post("/", (req, res) => {
  const lead = getLead(String(req.body?.leadId ?? ""));
  if (!lead) return res.status(400).json({ error: "Pick an approved mockup to build from" });
  if (!existsSync(join(leadDir(lead.id), "mockup", "index.html"))) return res.status(400).json({ error: "That lead has no mockup yet" });
  const pages = makePages(cleanPages(req.body?.pages));
  if (pages.length < 2 || pages.length > 12) return res.status(400).json({ error: "A build needs the homepage plus 1–11 more pages" });
  const b = createBuild({
    leadId: lead.id,
    business: lead.business || new URL(lead.url).hostname.replace(/^www\./, ""),
    url: lead.url,
    homepageChanges: String(req.body?.homepageChanges ?? "").trim(),
    details: String(req.body?.details ?? "").trim(),
    pages,
  });
  if (req.body?.start) enqueueBuild({ id: b.id, kind: "build" });
  res.json(getBuild(b.id));
});

builds.get("/:id", (req, res) => {
  const b = getBuild(req.params.id);
  if (!b) return res.sendStatus(404);
  res.json({ ...b, hasZip: existsSync(join(buildDir(b.id), "site.zip")) });
});

/** Edit the brief. Changing it resets the build so everything is regenerated. */
builds.put("/:id", (req, res) => {
  const b = getBuild(req.params.id);
  if (!b) return res.sendStatus(404);
  if (b.status === "running" || b.status === "queued") return res.status(409).json({ error: "Wait for the current run to finish" });
  if (typeof req.body?.homepageChanges === "string") b.homepageChanges = req.body.homepageChanges.trim();
  if (typeof req.body?.details === "string") b.details = req.body.details.trim();
  if (Array.isArray(req.body?.pages)) {
    const pages = makePages(cleanPages(req.body.pages));
    if (pages.length < 2 || pages.length > 12) return res.status(400).json({ error: "A build needs the homepage plus 1–11 more pages" });
    b.pages = pages;
  }
  b.steps = BUILD_STEPS.map((s) => ({ key: s.key, status: "pending" }));
  b.linkCheck = null;
  b.status = "draft";
  saveBuild(b);
  res.json(b);
});

builds.post("/:id/start", (req, res) => {
  const b = getBuild(req.params.id);
  if (!b) return res.sendStatus(404);
  const from = req.body?.from as string | undefined;
  if (from) {
    const idx = BUILD_STEPS.findIndex((s) => s.key === from);
    b.steps.forEach((s, i) => { if (i >= idx) Object.assign(s, { status: "pending", note: undefined }); });
    if (idx <= 2) b.pages.forEach((p, i) => { if (i > 0 || idx <= 1) p.status = "pending"; });
    saveBuild(b);
  }
  enqueueBuild({ id: b.id, kind: "build" });
  res.json({ ok: true });
});

builds.post("/:id/pages/:slug/revise", (req, res) => {
  const b = getBuild(req.params.id);
  if (!b) return res.sendStatus(404);
  const page = b.pages.find((p) => p.slug === req.params.slug);
  const changes = String(req.body?.changes ?? "").trim();
  if (!page) return res.sendStatus(404);
  if (page.status !== "done") return res.status(409).json({ error: "This page hasn't been written yet" });
  if (changes.length < 3) return res.status(400).json({ error: "Describe what should change" });
  page.pendingChanges = changes;
  saveBuild(b);
  enqueueBuild({ id: b.id, kind: "revise", slug: page.slug });
  res.json({ ok: true });
});

builds.get("/:id/download", (req, res) => {
  const b = getBuild(req.params.id);
  const zip = b && join(buildDir(b.id), "site.zip");
  if (!b || !existsSync(zip!)) return res.sendStatus(404);
  const name = b.business.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "website";
  res.download(zip!, `${name}-website.zip`);
});

builds.delete("/:id", (req, res) => {
  const b = getBuild(req.params.id);
  if (!b) return res.sendStatus(404);
  if (b.status === "running") return res.status(409).json({ error: "Wait for the current run to finish" });
  deleteBuildRow(b.id);
  rmSync(buildDir(b.id), { recursive: true, force: true });
  res.json({ ok: true });
});
