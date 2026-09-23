import { Router } from "express";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { addEvent } from "../db.ts";
import { getBuild } from "../builds/store.ts";
import { ClaudeUnavailableError } from "../claude/runner.ts";
import { NeedsUserError, checkConnection, convertPage, nextPendingPage, pluginPath, rebuildPlugin, resumeConversions } from "./pipeline.ts";
import { convDir, createConversion, deleteConversionRow, getConversion, listConversions, saveConversion, setSecret } from "./store.ts";

/* ---------- queue: one page at a time ---------- */

type Job = { id: string; slug: string; feedback?: string; sectionIndex?: number };
const queue: Job[] = [];
let busy = false;

function enqueue(job: Job) {
  if (!queue.some((j) => j.id === job.id && j.slug === job.slug)) queue.push(job);
  void pump();
}

async function pump() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;
  try {
    await convertPage(job.id, job.slug, { feedback: job.feedback, sectionIndex: job.sectionIndex });
  } catch (e) {
    const c = getConversion(job.id);
    if (c) {
      const page = c.pages.find((p) => p.slug === job.slug);
      const waiting = e instanceof NeedsUserError || e instanceof ClaudeUnavailableError;
      if (page) {
        page.status = waiting ? "pending" : "failed";
        page.note = (e as Error).message.slice(0, 300);
        for (const s of page.sections) if (s.status === "converting") s.status = "pending";
      }
      c.status = waiting ? "paused" : "failed";
      c.error = (e as Error).message.slice(0, 400);
      saveConversion(c);
      if (!waiting) {
        addEvent({ leadId: null, kind: "failed", title: "WordPress conversion failed", detail: `${c.business}: ${c.error.slice(0, 120)}` });
        console.error(`[wp ${job.id}]`, e);
      }
    }
  } finally {
    busy = false;
    void pump();
  }
}

export function resumeWp() {
  resumeConversions((id, slug) => enqueue({ id, slug }));
}

/* ---------- routes ---------- */

export const wp = Router();

wp.get("/", (_req, res) => res.json(listConversions()));

wp.get("/stats", (_req, res) => {
  const all = listConversions();
  res.json({
    total: all.length,
    awaiting: all.filter((c) => c.status === "awaiting_approval").length,
    done: all.filter((c) => c.status === "done").length,
    pagesApproved: all.reduce((n, c) => n + c.pages.filter((p) => p.status === "approved").length, 0),
  });
});

wp.post("/", async (req, res) => {
  const build = getBuild(String(req.body?.buildId ?? ""));
  if (!build) return res.status(400).json({ error: "Pick a finished website build to convert" });
  let siteUrl: string;
  try {
    siteUrl = new URL(String(req.body?.siteUrl ?? "")).origin;
  } catch {
    return res.status(400).json({ error: "Enter the WordPress site URL, e.g. https://client-site.com" });
  }
  const c = createConversion(build, {
    siteUrl,
    wpUser: String(req.body?.wpUser ?? "").trim(),
    appPassword: String(req.body?.appPassword ?? "").trim(),
    elementorPro: Boolean(req.body?.elementorPro),
  });
  await rebuildPlugin(c);
  res.json(c);
});

wp.get("/:id", (req, res) => {
  const c = getConversion(req.params.id);
  if (!c) return res.sendStatus(404);
  res.json({ ...c, queued: queue.filter((j) => j.id === c.id).map((j) => j.slug), pluginFile: existsSync(pluginPath(c)) });
});

wp.put("/:id/credentials", (req, res) => {
  const c = getConversion(req.params.id);
  if (!c) return res.sendStatus(404);
  if (typeof req.body?.wpUser === "string") c.wpUser = req.body.wpUser.trim();
  if (typeof req.body?.appPassword === "string" && req.body.appPassword.trim()) {
    setSecret(c.id, req.body.appPassword.trim());
    c.appPasswordSet = true;
  }
  saveConversion(c);
  res.json(c);
});

wp.post("/:id/test", async (req, res) => {
  const c = getConversion(req.params.id);
  if (!c) return res.sendStatus(404);
  try {
    await checkConnection(c);
    res.json({ ok: true, connected: getConversion(c.id)!.connected });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message, connected: getConversion(c.id)!.connected });
  }
});

wp.get("/:id/plugin", (req, res) => {
  const c = getConversion(req.params.id);
  if (!c || !existsSync(pluginPath(c))) return res.sendStatus(404);
  res.download(pluginPath(c), "studio-connector.zip");
});

/** Start (or continue) with the next page that isn't approved yet. */
wp.post("/:id/start", (req, res) => {
  const c = getConversion(req.params.id);
  if (!c) return res.sendStatus(404);
  const waiting = c.pages.find((p) => p.status === "awaiting_approval");
  if (waiting) return res.status(409).json({ error: `Approve or send feedback on ${waiting.title} first` });
  const next = nextPendingPage(c);
  if (!next) return res.status(409).json({ error: "Every page is already approved" });
  c.error = undefined;
  saveConversion(c);
  enqueue({ id: c.id, slug: next.slug });
  res.json({ ok: true, slug: next.slug });
});

wp.post("/:id/pages/:slug/approve", (req, res) => {
  const c = getConversion(req.params.id);
  const page = c?.pages.find((p) => p.slug === req.params.slug);
  if (!c || !page) return res.sendStatus(404);
  if (page.status !== "awaiting_approval") return res.status(409).json({ error: "This page isn't waiting for approval" });
  page.status = "approved";
  const next = nextPendingPage(c);
  c.status = next ? "running" : "done";
  saveConversion(c);
  if (next) enqueue({ id: c.id, slug: next.slug });
  else addEvent({ leadId: null, kind: "ready", title: "WordPress conversion complete", detail: `${c.business}: all ${c.pages.length} pages approved` });
  res.json({ ok: true, next: next?.slug ?? null });
});

wp.post("/:id/pages/:slug/changes", (req, res) => {
  const c = getConversion(req.params.id);
  const page = c?.pages.find((p) => p.slug === req.params.slug);
  if (!c || !page) return res.sendStatus(404);
  const feedback = String(req.body?.feedback ?? "").trim();
  if (feedback.length < 3) return res.status(400).json({ error: "Describe what should change" });
  const sectionIndex = req.body?.sectionIndex === undefined || req.body.sectionIndex === "" ? undefined : Number(req.body.sectionIndex);
  page.status = "changes_requested";
  page.feedback = feedback;
  saveConversion(c);
  enqueue({ id: c.id, slug: page.slug, feedback, sectionIndex });
  res.json({ ok: true });
});

wp.delete("/:id", (req, res) => {
  const c = getConversion(req.params.id);
  if (!c) return res.sendStatus(404);
  if (busy && queue.length === 0 && c.status === "running") return res.status(409).json({ error: "Wait for the current page to finish" });
  deleteConversionRow(c.id);
  rmSync(convDir(c.id), { recursive: true, force: true });
  res.json({ ok: true });
});
