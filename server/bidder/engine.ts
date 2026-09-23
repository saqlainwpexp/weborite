import { addEvent } from "../db.ts";
import { ClaudeUnavailableError } from "../claude/runner.ts";
import { getSelf, placeBid, projectUrl, searchActive, type FlProject, type FlUser } from "./freelancer.ts";
import { suggestAmount, clampAmount } from "./pricing.ts";
import { writeProposal } from "./writer.ts";
import {
  bidsSince, getConfig, getProject, hasProject, insertProject, listByStatus, publicConfig, saveProject, setConfig, startOfToday,
} from "./store.ts";
import type { BidderConfig, BidderState, BidProject } from "../../shared/types.ts";

const poller: BidderState["poller"] = { running: false, lastPollAt: null, nextPollAt: null, lastError: null, lastFound: 0 };
let timer: NodeJS.Timeout | null = null;
let polling = false;
let drafting = false;

export const pollerState = () => ({ ...poller, running: Boolean(timer) });

/** (Re)start or stop the timer to match the saved settings. */
export function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  poller.nextPollAt = null;
  const cfg = getConfig();
  if (!cfg.enabled || !cfg.token) return;
  const ms = Math.max(1, cfg.pollMinutes) * 60_000;
  poller.nextPollAt = new Date(Date.now() + ms).toISOString();
  timer = setTimeout(() => {
    timer = null;
    void pollNow().finally(schedule);
  }, ms);
}

/** Called once on server start. */
export function startBidder() {
  // Work interrupted by a restart: drafts start over; a bid that was mid-flight needs a manual check.
  for (const p of listByStatus("drafting")) saveProject({ ...p, status: "new" });
  for (const p of listByStatus("bidding")) saveProject({ ...p, status: "failed", note: "The app closed while this bid was being sent. Check the project on Freelancer before retrying." });
  const cfg = getConfig();
  if (cfg.enabled && cfg.token) void pollNow().finally(schedule);
  else void draftPending();
}

// ---- mapping + filters ----

function toProject(p: FlProject, users: Record<string, FlUser>, cfg: Pick<BidderConfig, "env">): BidProject {
  const u = users[String(p.owner_id)];
  const rep = u?.employer_reputation?.entire_history;
  const posted = p.time_submitted ?? p.submitdate;
  return {
    id: p.id,
    title: p.title,
    url: projectUrl(cfg.env, p),
    description: (p.description || p.preview_description || "").trim(),
    type: p.type === "hourly" ? "hourly" : "fixed",
    // exchange_rate converts the project's currency to USD (1 for USD).
    currency: { code: p.currency?.code ?? "USD", sign: p.currency?.sign ?? "$", usdRate: p.currency?.exchange_rate || 1 },
    budget: { min: Number(p.budget?.minimum) || 0, max: p.budget?.maximum ? Number(p.budget.maximum) : null },
    bidCount: p.bid_stats?.bid_count ?? 0,
    bidAvg: p.bid_stats?.bid_avg ?? null,
    skills: (p.jobs ?? []).map((j) => j.name),
    client: {
      id: p.owner_id,
      username: u?.username ?? "",
      country: u?.location?.country?.name ?? "",
      paymentVerified: Boolean(u?.status?.payment_verified),
      rating: rep?.overall ?? null,
      reviews: rep?.reviews ?? null,
    },
    postedAt: posted ? new Date(posted * 1000).toISOString() : new Date().toISOString(),
    foundAt: new Date().toISOString(),
    status: "new",
  };
}

export function skipReason(p: BidProject, cfg: Omit<BidderConfig, "tokenSet">): string | null {
  if (!cfg.types[p.type]) return `${p.type === "hourly" ? "Hourly" : "Fixed-price"} projects are turned off`;
  const topUsd = (p.budget.max ?? p.budget.min) * p.currency.usdRate;
  const min = p.type === "hourly" ? cfg.minHourlyUsd : cfg.minFixedUsd;
  if (topUsd < min) return `Budget under your minimum ($${min}${p.type === "hourly" ? "/hr" : ""})`;
  if (p.bidCount > cfg.maxBidCount) return `${p.bidCount} bids already (your limit is ${cfg.maxBidCount})`;
  if (cfg.requirePaymentVerified && !p.client.paymentVerified) return "Client's payment isn't verified";
  if (p.client.country && cfg.excludeCountries.some((c) => c.trim().toLowerCase() === p.client.country.toLowerCase())) return `Client is in ${p.client.country}`;
  const text = `${p.title}\n${p.description}`.toLowerCase();
  const word = cfg.exclude.map((w) => w.trim().toLowerCase()).find((w) => w && text.includes(w));
  if (word) return `Mentions “${word}”`;
  return null;
}

// ---- polling ----

export async function pollNow() {
  if (polling) return;
  polling = true;
  const cfg = getConfig();
  try {
    if (!cfg.token) throw new Error("Save your Freelancer access token in Bid settings first.");
    const types = (["fixed", "hourly"] as const).filter((t) => cfg.types[t]);
    const { projects, users } = await searchActive(cfg.env, cfg.token, { jobs: cfg.skills.map((s) => s.id), query: cfg.query.trim(), types, limit: 50 });
    const oldest = Date.now() - cfg.maxAgeMinutes * 60_000;
    let found = 0;
    for (const raw of projects) {
      if (hasProject(raw.id)) continue;
      const p = toProject(raw, users, cfg);
      // Older posts are left alone (not stored), so the first run doesn't flood you with a backlog.
      if (new Date(p.postedAt).getTime() < oldest) continue;
      const why = skipReason(p, cfg);
      if (why) Object.assign(p, { status: "skipped", note: why });
      else found++;
      insertProject(p);
    }
    poller.lastFound = found;
    poller.lastError = null;
    if (found) addEvent({ leadId: null, kind: "info", title: "New Freelancer projects", detail: `${found} matching project${found === 1 ? "" : "s"} found; drafting proposals` });
  } catch (e) {
    poller.lastError = (e as Error).message.slice(0, 300);
    console.error("[bidder] poll failed:", e);
  } finally {
    poller.lastPollAt = new Date().toISOString();
    polling = false;
  }
  await draftPending();
}

// ---- drafting ----

/** Write proposals for every "new" project, one at a time. */
export async function draftPending() {
  if (drafting) return;
  drafting = true;
  try {
    for (;;) {
      const next = listByStatus("new")[0];
      if (!next) break;
      const ok = await draftOne(next.id);
      if (!ok) break;
    }
  } finally {
    drafting = false;
  }
}

/** Returns false when Claude is unavailable, so the queue waits for the next poll. */
async function draftOne(id: number): Promise<boolean> {
  const cfg = publicConfig();
  const p = getProject(id);
  if (!p) return true;
  saveProject({ ...p, status: "drafting", note: undefined });
  try {
    const draft = await writeProposal(p, cfg);
    const cur = getProject(id) ?? p;
    if (!draft.shouldBid) {
      saveProject({ ...cur, status: "skipped", draft, note: draft.reason || "Claude advised not to bid" });
      return true;
    }
    const amount = suggestAmount(cur, draft.complexity, cfg);
    saveProject({ ...cur, status: "ready", draft, amount, days: draft.days, proposal: draft.proposal, note: undefined });
    if (cfg.mode === "auto" && cfg.enabled) {
      // submitBid records its own failure on the project.
      if (bidsSince(startOfToday()) < cfg.dailyBidLimit) await submitBid(id).catch(() => {});
      else saveProject({ ...getProject(id)!, note: `Daily limit of ${cfg.dailyBidLimit} bids reached; waiting for your review` });
    }
    return true;
  } catch (e) {
    const cur = getProject(id) ?? p;
    if (e instanceof ClaudeUnavailableError) {
      saveProject({ ...cur, status: "new", note: `Waiting for Claude: ${e.message.slice(0, 200)}` });
      poller.lastError = `Claude unavailable: ${e.message.slice(0, 200)}`;
      return false;
    }
    saveProject({ ...cur, status: "failed", note: `Couldn't write the proposal: ${(e as Error).message.slice(0, 200)}` });
    return true;
  }
}

/** Put a project back in the drafting queue (e.g. after you edit your profile). */
export function redraft(id: number) {
  const p = getProject(id);
  if (!p || p.status === "bid" || p.status === "bidding" || p.status === "drafting") return false;
  saveProject({ ...p, status: "new", note: undefined });
  void draftPending();
  return true;
}

// ---- bidding ----

export async function ensureUser() {
  const cfg = getConfig();
  if (cfg.user) return cfg.user;
  const me = await getSelf(cfg.env, cfg.token);
  const user = { id: me.id, username: me.username, displayName: me.display_name || me.public_name || me.username };
  setConfig({ user });
  return user;
}

export async function submitBid(id: number) {
  const cfg = getConfig();
  const p = getProject(id);
  if (!p) throw new Error("Project not found");
  if (p.status === "bid") throw new Error("You already bid on this project");
  if (p.status === "bidding") throw new Error("This bid is already being sent");
  if (!cfg.token) throw new Error("Save your Freelancer access token in Bid settings first.");
  const proposal = (p.proposal ?? "").trim();
  if (proposal.length < 100) throw new Error("The proposal is too short (Freelancer expects at least 100 characters).");
  // Never outside the client's range, whatever was typed.
  const amount = clampAmount(p, p.amount ?? suggestAmount(p, p.draft?.complexity ?? 0.5, cfg), cfg);
  const days = Math.min(365, Math.max(1, Math.round(p.days ?? p.draft?.days ?? 7)));

  saveProject({ ...p, status: "bidding", amount, days, note: undefined });
  try {
    const user = await ensureUser();
    const bid = await placeBid(cfg.env, cfg.token, { projectId: p.id, bidderId: user.id, amount, days, description: proposal });
    const done: BidProject = { ...getProject(id)!, status: "bid", bidId: bid.id, bidAt: new Date().toISOString(), note: undefined };
    saveProject(done);
    addEvent({ leadId: null, kind: "ready", title: "Bid placed on Freelancer", detail: `${p.title}: ${p.currency.sign}${amount}${p.type === "hourly" ? "/hr" : ""} in ${days} days` });
    return done;
  } catch (e) {
    const failed: BidProject = { ...getProject(id)!, status: "failed", note: `Bid failed: ${(e as Error).message.slice(0, 300)}` };
    saveProject(failed);
    addEvent({ leadId: null, kind: "failed", title: "Freelancer bid failed", detail: `${p.title}: ${(e as Error).message.slice(0, 160)}` });
    throw e;
  }
}
