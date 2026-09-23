import { addEvent } from "../db.ts";
import { ClaudeUnavailableError } from "../claude/runner.ts";
import { revisePage, runBuild } from "./pipeline.ts";
import { getBuild, listBuilds, saveBuild } from "./store.ts";

type Job = { id: string; kind: "build" } | { id: string; kind: "revise"; slug: string };
const RESUME_AFTER_MS = 20 * 60 * 1000;
const queue: Job[] = [];
let busy = false;

export function enqueueBuild(job: Job) {
  if (!queue.some((j) => j.id === job.id && j.kind === job.kind && (j.kind !== "revise" || (job.kind === "revise" && j.slug === job.slug)))) queue.push(job);
  const b = getBuild(job.id);
  if (b && b.status !== "running") {
    b.status = "queued";
    saveBuild(b);
  }
  void pump();
}

async function pump() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;
  try {
    if (job.kind === "build") await runBuild(job.id);
    else await revisePage(job.id, job.slug);
  } catch (e) {
    const b = getBuild(job.id);
    if (b) {
      if (e instanceof ClaudeUnavailableError) {
        b.status = "paused";
        b.error = e.message;
        setTimeout(() => enqueueBuild(job), RESUME_AFTER_MS);
      } else {
        b.status = "failed";
        b.error = (e as Error).message.slice(0, 400);
        addEvent({ leadId: b.leadId, kind: "failed", title: "Website build failed", detail: `${b.business}: ${b.error.slice(0, 120)}` });
        console.error(`[build ${job.id}]`, e);
      }
      saveBuild(b);
    }
  } finally {
    busy = false;
    void pump();
  }
}

export function buildQueueState() {
  return { busy, queued: queue.length };
}

/** Finish builds interrupted by a restart. */
export function resumeBuilds() {
  for (const b of listBuilds().reverse()) if (b.status === "queued" || b.status === "running") enqueueBuild({ id: b.id, kind: "build" });
}
