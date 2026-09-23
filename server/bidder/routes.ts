import { Router } from "express";
import { FreelancerError, getSelf, listJobs, type FlEnv, type FlJob } from "./freelancer.ts";
import { clampAmount, suggestAmount } from "./pricing.ts";
import { draftPending, ensureUser, pollNow, pollerState, redraft, schedule, submitBid } from "./engine.ts";
import { bidsSince, countBy, deleteProject, getConfig, getProject, listProjects, publicConfig, saveProject, setConfig, startOfToday } from "./store.ts";
import type { BidderState } from "../../shared/types.ts";

export const bidder = Router();

const errStatus = (e: unknown) => (e instanceof FreelancerError && e.status >= 400 && e.status < 500 ? 400 : 502);

function state(): BidderState {
  const c = countBy() as Record<string, number> & { total: number };
  return {
    config: publicConfig(),
    poller: pollerState(),
    stats: { total: c.total, ready: c.ready ?? 0, bidToday: bidsSince(startOfToday()), bidTotal: c.bid ?? 0, skipped: c.skipped ?? 0, failed: c.failed ?? 0 },
  };
}

bidder.get("/state", (_req, res) => res.json(state()));

const num = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const lines = (v: unknown) =>
  (Array.isArray(v) ? v : String(v ?? "").split(/\r?\n|,/)).map((s) => String(s).trim()).filter(Boolean).slice(0, 100);

bidder.put("/config", (req, res) => {
  const b = req.body ?? {};
  const cur = getConfig();
  const patch: Partial<ReturnType<typeof getConfig>> = {};
  if (b.env === "live" || b.env === "sandbox") {
    patch.env = b.env;
    // Sandbox and live are separate accounts with different user ids.
    if (b.env !== cur.env) patch.user = null;
  }
  if (typeof b.enabled === "boolean") patch.enabled = b.enabled;
  if (b.mode === "review" || b.mode === "auto") patch.mode = b.mode;
  if (b.pollMinutes !== undefined) patch.pollMinutes = Math.round(num(b.pollMinutes, 1, 60, cur.pollMinutes));
  if (Array.isArray(b.skills))
    patch.skills = b.skills
      .map((s: { id?: unknown; name?: unknown }) => ({ id: Math.round(Number(s?.id)), name: String(s?.name ?? "").slice(0, 80) }))
      .filter((s: { id: number }) => s.id > 0)
      .slice(0, 100);
  if (typeof b.query === "string") patch.query = b.query.trim().slice(0, 200);
  if (b.exclude !== undefined) patch.exclude = lines(b.exclude);
  if (b.excludeCountries !== undefined) patch.excludeCountries = lines(b.excludeCountries);
  if (b.types && typeof b.types === "object") patch.types = { fixed: b.types.fixed !== false, hourly: b.types.hourly !== false };
  if (b.minFixedUsd !== undefined) patch.minFixedUsd = num(b.minFixedUsd, 0, 1e6, cur.minFixedUsd);
  if (b.minHourlyUsd !== undefined) patch.minHourlyUsd = num(b.minHourlyUsd, 0, 1e4, cur.minHourlyUsd);
  if (b.maxBidCount !== undefined) patch.maxBidCount = Math.round(num(b.maxBidCount, 0, 10_000, cur.maxBidCount));
  if (b.maxAgeMinutes !== undefined) patch.maxAgeMinutes = Math.round(num(b.maxAgeMinutes, 5, 10_080, cur.maxAgeMinutes));
  if (typeof b.requirePaymentVerified === "boolean") patch.requirePaymentVerified = b.requirePaymentVerified;
  if (b.dailyBidLimit !== undefined) patch.dailyBidLimit = Math.round(num(b.dailyBidLimit, 0, 500, cur.dailyBidLimit));
  if (b.floorPct !== undefined) patch.floorPct = num(b.floorPct, 0, 100, cur.floorPct);
  if (b.ceilPct !== undefined) patch.ceilPct = num(b.ceilPct, 0, 100, cur.ceilPct);
  if (b.openBudgetFactor !== undefined) patch.openBudgetFactor = num(b.openBudgetFactor, 1, 5, cur.openBudgetFactor);
  if (typeof b.profile === "string") patch.profile = b.profile.slice(0, 8000);
  if (typeof b.samples === "string") patch.samples = b.samples.slice(0, 12000);

  const next = { ...cur, ...patch };
  if (next.floorPct > next.ceilPct) return res.status(400).json({ error: "The lowest point in the range can't be above the highest." });
  if (next.enabled && !next.token) return res.status(400).json({ error: "Save your Freelancer access token before turning the bidder on." });
  setConfig(patch);
  schedule();
  res.json(state());
});

/** Save a token after checking it against the API. */
bidder.post("/token", async (req, res) => {
  const token = String(req.body?.token ?? "").trim();
  const env: FlEnv = req.body?.env === "live" ? "live" : req.body?.env === "sandbox" ? "sandbox" : getConfig().env;
  if (!token) {
    // An empty token removes it and stops the bidder.
    setConfig({ token: "", user: null, enabled: false });
    schedule();
    return res.json(state());
  }
  try {
    const me = await getSelf(env, token);
    setConfig({ token, env, user: { id: me.id, username: me.username, displayName: me.display_name || me.public_name || me.username } });
    schedule();
    res.json(state());
  } catch (e) {
    res.status(errStatus(e)).json({ error: `Couldn't sign in to ${env === "live" ? "freelancer.com" : "the Freelancer sandbox"}: ${(e as Error).message}` });
  }
});

bidder.post("/test", async (_req, res) => {
  try {
    setConfig({ user: null });
    const user = await ensureUser();
    res.json({ ok: true, user });
  } catch (e) {
    res.status(errStatus(e)).json({ error: (e as Error).message });
  }
});

// Skills list, cached per environment for the session.
const jobCache = new Map<FlEnv, FlJob[]>();
bidder.get("/skills", async (req, res) => {
  const cfg = getConfig();
  if (!cfg.token) return res.status(400).json({ error: "Save your Freelancer access token first." });
  const q = String(req.query.q ?? "").trim().toLowerCase();
  try {
    if (!jobCache.has(cfg.env)) jobCache.set(cfg.env, await listJobs(cfg.env, cfg.token));
    const all = jobCache.get(cfg.env)!;
    const hits = all
      .filter((j) => !q || j.name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)) || (b.active_project_count ?? 0) - (a.active_project_count ?? 0))
      .slice(0, 25)
      .map((j) => ({ id: j.id, name: j.name, category: j.category?.name ?? "", active: j.active_project_count ?? null }));
    res.json(hits);
  } catch (e) {
    res.status(errStatus(e)).json({ error: (e as Error).message });
  }
});

bidder.post("/poll", (_req, res) => {
  if (!getConfig().token) return res.status(400).json({ error: "Save your Freelancer access token in Bid settings first." });
  void pollNow().finally(schedule);
  res.json({ ok: true });
});

bidder.get("/projects", (_req, res) => res.json(listProjects()));

bidder.get("/projects/:id", (req, res) => {
  const p = getProject(Number(req.params.id));
  if (!p) return res.sendStatus(404);
  res.json(p);
});

/** Edit the proposal, amount or delivery days before bidding. */
bidder.put("/projects/:id", (req, res) => {
  const p = getProject(Number(req.params.id));
  if (!p) return res.sendStatus(404);
  if (p.status === "bid" || p.status === "bidding") return res.status(400).json({ error: "This bid was already sent." });
  const cfg = getConfig();
  const b = req.body ?? {};
  if (typeof b.proposal === "string") p.proposal = b.proposal.slice(0, 4000);
  if (b.amount !== undefined && Number.isFinite(Number(b.amount))) p.amount = clampAmount(p, Number(b.amount), cfg);
  if (b.days !== undefined && Number.isFinite(Number(b.days))) p.days = Math.min(365, Math.max(1, Math.round(Number(b.days))));
  // A skipped project you decide to bid on anyway moves to review.
  if ((p.status === "skipped" || p.status === "failed") && p.proposal) {
    p.status = "ready";
    p.amount ??= suggestAmount(p, p.draft?.complexity ?? 0.5, cfg);
    p.days ??= p.draft?.days ?? 7;
  }
  saveProject(p);
  res.json(p);
});

bidder.post("/projects/:id/bid", async (req, res) => {
  try {
    res.json(await submitBid(Number(req.params.id)));
  } catch (e) {
    res.status(e instanceof FreelancerError ? errStatus(e) : 400).json({ error: (e as Error).message });
  }
});

bidder.post("/projects/:id/redraft", (req, res) => {
  if (!redraft(Number(req.params.id))) return res.status(400).json({ error: "This project can't be redrafted right now." });
  res.json({ ok: true });
});

bidder.post("/projects/:id/skip", (req, res) => {
  const p = getProject(Number(req.params.id));
  if (!p) return res.sendStatus(404);
  if (p.status === "bid" || p.status === "bidding") return res.status(400).json({ error: "This bid was already sent." });
  saveProject({ ...p, status: "skipped", note: "Skipped by you" });
  res.json({ ok: true });
});

bidder.delete("/projects/:id", (req, res) => {
  deleteProject(Number(req.params.id));
  res.json({ ok: true });
});

/** Draft anything still waiting (e.g. after Claude comes back). */
bidder.post("/draft", (_req, res) => {
  void draftPending();
  res.json({ ok: true });
});
