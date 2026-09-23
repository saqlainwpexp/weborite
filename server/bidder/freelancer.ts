/**
 * Minimal client for the freelancer.com REST API (v0.1).
 * Auth is a personal OAuth token sent in the `freelancer-oauth-v1` header.
 * Docs: https://developers.freelancer.com
 */

export type FlEnv = "live" | "sandbox";

const BASE: Record<FlEnv, string> = {
  live: "https://www.freelancer.com/api",
  sandbox: "https://www.freelancer-sandbox.com/api",
};
const SITE: Record<FlEnv, string> = {
  live: "https://www.freelancer.com",
  sandbox: "https://www.freelancer-sandbox.com",
};

export class FreelancerError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | (string | number)[] | undefined>;

async function call<T>(env: FlEnv, token: string, method: "GET" | "POST", path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
  // FREELANCER_API_BASE points the client at a local mock for testing.
  const url = new URL((process.env.FREELANCER_API_BASE ?? BASE[env]) + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined) continue;
    // Array params use the PHP style the API expects: jobs[]=3&jobs[]=17
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(`${k}[]`, String(item));
    else url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      "freelancer-oauth-v1": token,
      Accept: "application/json",
      ...(opts.body !== undefined && { "Content-Type": "application/json" }),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => null)) as { status?: string; result?: T; message?: string; error_code?: string } | null;
  if (!res.ok || !data || data.status !== "success") {
    const msg = data?.message || `Freelancer API ${res.status}`;
    if (res.status === 401) throw new FreelancerError(`The Freelancer token was rejected (${msg}). Generate a new one and save it in Bid settings.`, 401, data?.error_code);
    throw new FreelancerError(msg, res.status, data?.error_code);
  }
  return data.result as T;
}

// ---- response shapes (only the fields we use) ----

export interface FlUser {
  id: number;
  username: string;
  display_name?: string;
  public_name?: string;
  location?: { country?: { name?: string } };
  status?: { payment_verified?: boolean; email_verified?: boolean; deposit_made?: boolean };
  employer_reputation?: { entire_history?: { overall?: number; reviews?: number } };
}

export interface FlProject {
  id: number;
  owner_id: number;
  title: string;
  seo_url?: string;
  description?: string;
  preview_description?: string;
  type: "fixed" | "hourly";
  status?: string;
  currency: { code: string; sign: string; exchange_rate?: number };
  budget: { minimum?: number; maximum?: number | null };
  bid_stats?: { bid_count?: number; bid_avg?: number | null };
  jobs?: { id: number; name: string }[];
  time_submitted?: number;
  submitdate?: number;
  bidperiod?: number;
}

export interface FlJob {
  id: number;
  name: string;
  category?: { id: number; name: string };
  active_project_count?: number;
}

// ---- endpoints ----

export function getSelf(env: FlEnv, token: string) {
  return call<FlUser>(env, token, "GET", "/users/0.1/self/");
}

/** Every skill ("job") on the site. About 2,000 entries; cached by the caller. */
export function listJobs(env: FlEnv, token: string) {
  return call<FlJob[]>(env, token, "GET", "/projects/0.1/jobs/");
}

export async function searchActive(env: FlEnv, token: string, q: { jobs: number[]; query: string; types: ("fixed" | "hourly")[]; limit: number }) {
  const r = await call<{ projects: FlProject[]; users?: Record<string, FlUser> }>(env, token, "GET", "/projects/0.1/projects/active/", {
    query: {
      ...(q.jobs.length && { jobs: q.jobs }),
      ...(q.query && { query: q.query, or_search_query: true }),
      ...(q.types.length === 1 && { project_types: q.types }),
      sort_field: "time_updated",
      limit: q.limit,
      full_description: true,
      job_details: true,
      user_details: true,
      user_status: true,
      user_country_details: true,
      user_employer_reputation: true,
      compact: true,
    },
  });
  return { projects: r.projects ?? [], users: r.users ?? {} };
}

export function placeBid(env: FlEnv, token: string, bid: { projectId: number; bidderId: number; amount: number; days: number; description: string }) {
  return call<{ id: number }>(env, token, "POST", "/projects/0.1/bids/", {
    body: {
      project_id: bid.projectId,
      bidder_id: bid.bidderId,
      amount: bid.amount,
      period: bid.days,
      milestone_percentage: 100,
      description: bid.description,
    },
  });
}

export function projectUrl(env: FlEnv, p: Pick<FlProject, "id" | "seo_url">) {
  return p.seo_url ? `${SITE[env]}/projects/${p.seo_url}` : `${SITE[env]}/projects/${p.id}`;
}
