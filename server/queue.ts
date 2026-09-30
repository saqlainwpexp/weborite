import { addEvent, getLead, readJson, saveLead, writeJson, leadDir } from "./db.ts";
import { ClaudeUnavailableError } from "./claude/runner.ts";
import { Pool, parallel } from "./pool.ts";
import { captureSite, type CaptureOutput } from "./pipeline/capture.ts";
import { diagnose, diagnoseScratch } from "./pipeline/diagnose.ts";
import { captureListing } from "./pipeline/listing.ts";
import { getProspect } from "./finder/store.ts";
import { ensureBenchmarks, getBenchmarkSet } from "./pipeline/benchmarks.ts";
import { generateMockup } from "./pipeline/generate.ts";
import { runGate } from "./pipeline/gate.ts";
import { renderSideBySide } from "./pipeline/render.ts";
import type { Capture, Diagnosis, Fact, GateResult, Lead, StepKey } from "../shared/types.ts";

const RESUME_AFTER_MS = 20 * 60 * 1000;
// Several mockups run at once (Settings → Parallel jobs); each lead only once at a time.
const pool = new Pool<string>((id) => id, () => parallel("ai"), (id) => runLead(id));
const resumeTimers = new Map<string, NodeJS.Timeout>();

export function queueState() {
  return { running: pool.running, queued: pool.queued };
}

export function enqueue(id: string, opts: { restart?: boolean } = {}) {
  const lead = getLead(id);
  if (!lead) return;
  if (opts.restart) for (const s of lead.steps) Object.assign(s, { status: "pending", note: undefined, startedAt: undefined, finishedAt: undefined });
  lead.status = "queued";
  lead.error = undefined;
  saveLead(lead);
  if (!pool.isActive(id)) pool.push(id);
}

function step(lead: Lead, key: StepKey) {
  return lead.steps.find((s) => s.key === key)!;
}

async function doStep(lead: Lead, key: StepKey, fn: () => Promise<string | void>) {
  const s = step(lead, key);
  if (s.status === "done") return;
  s.status = "running";
  s.startedAt = new Date().toISOString();
  s.note = undefined;
  saveLead(lead);
  try {
    const note = await fn();
    s.status = "done";
    s.note = note || undefined;
  } catch (e) {
    s.status = e instanceof ClaudeUnavailableError ? "pending" : "failed";
    s.note = (e as Error).message.slice(0, 300);
    throw e;
  } finally {
    s.finishedAt = new Date().toISOString();
    saveLead(lead);
  }
}

async function runLead(id: string) {
  const lead = getLead(id);
  if (!lead) return;
  lead.status = "running";
  saveLead(lead);
  const label = lead.business || new URL(lead.url).hostname;
  const scratch = lead.mode === "scratch";

  try {
    let cap: CaptureOutput | null = null;
    const loadCap = (): CaptureOutput => {
      const checks = readJson<{ mobile: CaptureOutput["mobile"]; contrast: CaptureOutput["contrast"] }>(id, "checks.json")!;
      return { capture: readJson<Capture>(id, "capture.json")!, facts: readJson<Fact[]>(id, "facts.json")!, ...checks };
    };

    await doStep(lead, "capture", async () => {
      if (scratch) {
        const p = lead.prospectId ? getProspect(lead.prospectId) : null;
        if (!p) throw new Error("The Lead Finder business behind this lead was removed");
        cap = await captureListing(id, p);
        return `No website: ${cap.capture.assets.length} photos and ${cap.facts.length} facts from the Google listing`;
      }
      cap = await captureSite(id, lead.url);
      return `${cap.capture.assets.length} assets, ${cap.facts.length} text blocks`;
    });
    cap ??= loadCap();

    await doStep(lead, "diagnose", async () => {
      const { diagnosis, vertical } = scratch ? await diagnoseScratch(id, cap!) : await diagnose(id, cap!);
      writeJson(id, "vertical.json", vertical);
      lead.vertical = vertical.key;
      return scratch ? `Palette proposed (${diagnosis.brand.primary}), hero photo picked` : `${diagnosis.issues.length} issues`;
    });
    const diagnosis = readJson<Diagnosis>(id, "diagnosis.json")!;
    const vertical = readJson<{ key: string; label: string; register: string }>(id, "vertical.json")!;
    lead.vertical = vertical.key;

    await doStep(lead, "vertical", async () => {
      const { set, created } = await ensureBenchmarks(id, leadDir(id), vertical);
      if (created) addEvent({ leadId: id, kind: "info", title: "New benchmark set", detail: `${set.label}: ${set.sites.length} sites researched` });
      return created ? `Researched new set: ${set.label}` : `Reused set: ${set.label}`;
    });
    const benchmarks = getBenchmarkSet(vertical.key);
    const input = { capture: cap.capture, diagnosis, facts: cap.facts, benchmarks, business: lead.business, scratch };

    await doStep(lead, "generate", async () => {
      await generateMockup(id, input);
    });

    let gate: GateResult | null = null;
    await doStep(lead, "gate", async () => {
      gate = await runGate(id, input, 1);
      if (!gate.pass) {
        const failures = gate.checks.filter((c) => !c.pass);
        step(lead, "gate").note = `Retrying: ${failures.map((f) => f.name).join(", ")}`;
        saveLead(lead);
        await generateMockup(id, input, { failures });
        gate = await runGate(id, input, 2);
      }
      const g = gate as GateResult;
      return g.pass ? "All checks passed" : `${g.checks.filter((c) => !c.pass).length} checks still failing`;
    });
    gate ??= readJson<GateResult>(id, "gate.json");

    await doStep(lead, "render", async () => {
      await renderSideBySide(id, { business: label, url: lead.url, gate, scratch });
    });

    const passed = (gate as GateResult | null)?.pass ?? false;
    lead.status = passed ? "ready" : "needs_review";
    addEvent({
      leadId: id,
      kind: passed ? "ready" : "review",
      title: passed ? "Mockup ready" : "Mockup needs review",
      detail: passed ? `${label} passed every check` : `${label}: some quality checks failed`,
    });
  } catch (e) {
    if (e instanceof ClaudeUnavailableError) {
      lead.status = "paused";
      lead.error = e.message;
      addEvent({ leadId: id, kind: "info", title: "Job paused", detail: e.message.slice(0, 140) });
      scheduleResume(id);
    } else {
      lead.status = "failed";
      lead.error = (e as Error).message.slice(0, 400);
      addEvent({ leadId: id, kind: "failed", title: "Job failed", detail: `${label}: ${lead.error.slice(0, 120)}` });
      console.error(`[lead ${id}]`, e);
    }
  }
  saveLead(lead);
}

function scheduleResume(id: string) {
  clearTimeout(resumeTimers.get(id));
  resumeTimers.set(id, setTimeout(() => {
    resumeTimers.delete(id);
    const l = getLead(id);
    if (l?.status === "paused") enqueue(id);
  }, RESUME_AFTER_MS));
}

/** Pick up anything interrupted by a server restart. */
export function resumeInterrupted(leads: Lead[]) {
  for (const l of leads) if (l.status === "queued" || l.status === "running") enqueue(l.id);
}
