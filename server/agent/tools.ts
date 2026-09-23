import { API_PORT } from "../db.ts";

/**
 * The assistant reaches every workspace through this fixed catalog of tools. Each maps to an existing
 * dashboard endpoint, so all the usual validation and security still apply. Read tools run
 * immediately; write tools are proposed to the user and only run once they tap Run.
 */

export interface Tool {
  name: string;
  write: boolean;
  /** Acts on a live client site or removes data: always confirmed, and flagged in red. */
  danger?: boolean;
  desc: string;
  /** arg name -> human description (shown to the model; "?" suffix marks optional). */
  args: Record<string, string>;
  /** A one-line, human summary of what running this will do (shown on the confirm card). */
  summary: (a: Args) => string;
  run: (a: Args) => Promise<unknown>;
}

export type Args = Record<string, string | number | boolean | undefined>;

const base = `http://127.0.0.1:${API_PORT}`;

/** Call the dashboard's own API. Server-side, so it carries no browser Origin and passes the guard. */
async function callApi(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function must(method: string, path: string, body?: unknown) {
  const r = await callApi(method, path, body);
  if (!r.ok) throw new Error((r.data as { error?: string })?.error || `Request failed (${r.status})`);
  return r.data;
}

const str = (v: Args[string]) => (v == null ? "" : String(v)).trim();
/** First non-empty of several arg names (models vary: siteUrl vs url vs site). */
const pick = (a: Args, ...keys: string[]) => { for (const k of keys) { const v = str(a[k]); if (v) return v; } return ""; };

/** Find a site across SEO / maintenance by URL or name, so the user can just say "example.com". */
async function findSite(kind: "seo" | "care", q: string) {
  const list = (await must("GET", `/api/${kind}`)) as { id: string; name: string; siteUrl: string }[];
  const needle = q.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    list.find((s) => s.id === q) ||
    list.find((s) => s.siteUrl.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "") === needle) ||
    list.find((s) => s.siteUrl.toLowerCase().includes(needle) || s.name.toLowerCase().includes(needle))
  );
}

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

export const TOOLS: Tool[] = [
  // ---------- reads ----------
  {
    name: "get_overview", write: false, args: {},
    desc: "A snapshot of every workspace: mockup leads, Lead Finder, builds, WordPress conversions, SEO sites, maintenance sites, channels. Call this first when you need to know what exists.",
    summary: () => "Read the overview",
    run: async () => {
      const [leads, searches, builds, wp, seo, care, comms] = await Promise.all([
        must("GET", "/api/leads"), must("GET", "/api/finder/searches"), must("GET", "/api/builds"),
        must("GET", "/api/wp"), must("GET", "/api/seo"), must("GET", "/api/care"), must("GET", "/api/comms"),
      ]);
      const L = leads as { id: string; business: string; url: string; status: string }[];
      const S = seo as { id: string; name: string; siteUrl: string }[];
      const C = care as { id: string; name: string; siteUrl: string; summary?: { label?: string } }[];
      return {
        mockups: { count: L.length, recent: L.slice(0, 8).map((l) => ({ id: l.id, business: l.business || host(l.url), status: l.status })) },
        finder_searches: (searches as { id: string; query: string; status: string }[]).slice(0, 8),
        builds: (builds as { id: string; name?: string; status: string }[]).map((b) => ({ id: b.id, name: b.name, status: b.status })),
        wordpress: (wp as { id: string; siteUrl: string; status: string }[]).map((c) => ({ id: c.id, site: host(c.siteUrl), status: c.status })),
        seo_sites: S.map((s) => ({ id: s.id, name: s.name, site: host(s.siteUrl) })),
        maintenance_sites: C.map((c) => ({ id: c.id, name: c.name, site: host(c.siteUrl) })),
        channels: (comms as { id: string; name: string }[]).map((c) => c.name),
      };
    },
  },
  {
    name: "get_seo_results", write: false, args: { site: "SEO site id, URL or name" },
    desc: "The latest QA, speed (perf) and on-page SEO results for one SEO site.",
    summary: (a) => `Read SEO results for ${str(a.site)}`,
    run: async (a) => {
      const site = pick(a, "site", "siteUrl", "url");
      const s = await findSite("seo", site);
      if (!s) throw new Error(`No SEO site matches "${site}". Add it first with add_seo_site.`);
      return { site: s.name, ...(await must("GET", `/api/seo/${s.id}/results`)) as object };
    },
  },

  // ---------- SEO / speed ----------
  {
    name: "add_seo_site", write: true, args: { siteUrl: "live site URL", name: "display name?", wpUser: "WordPress username?", appPassword: "WordPress application password?" },
    desc: "Add a site to the Launch & SEO workspace so QA, speed and on-page tests can run on it.",
    summary: (a) => `Add SEO site ${host(pick(a, "siteUrl", "url"))}`,
    run: (a) => must("POST", "/api/seo", { siteUrl: pick(a, "siteUrl", "url"), name: str(a.name), wpUser: str(a.wpUser), appPassword: str(a.appPassword) }),
  },
  {
    name: "run_seo_test", write: true, args: { site: "SEO site id, URL or name", phase: "one of: qa, perf, onpage (perf = speed test)" },
    desc: "Run a test on an existing SEO site: qa (post-launch checks), perf (page speed), or onpage (SEO). Runs in the background.",
    summary: (a) => `Run the ${str(a.phase) === "perf" ? "speed" : str(a.phase)} test on ${str(a.site)}`,
    run: async (a) => {
      const site = pick(a, "site", "siteUrl", "url");
      const s = await findSite("seo", site);
      if (!s) throw new Error(`No SEO site matches "${site}". Add it first with add_seo_site.`);
      const phase = str(a.phase) === "speed" ? "perf" : str(a.phase);
      await must("POST", `/api/seo/${s.id}/run/${phase}`);
      return { started: phase, site: s.name };
    },
  },
  {
    name: "speed_test", write: true, args: { siteUrl: "live site URL to speed-test", name: "display name?" },
    desc: "Shortcut: speed-test a website. Adds it to Launch & SEO if it isn't there yet, then runs the page-speed test. Use this for a plain 'check the speed of X'.",
    summary: (a) => `Speed-test ${host(pick(a, "siteUrl", "url", "site"))} (adds it to Launch & SEO if needed)`,
    run: async (a) => {
      const url = pick(a, "siteUrl", "url", "site");
      let s = await findSite("seo", url);
      if (!s) s = (await must("POST", "/api/seo", { siteUrl: url, name: str(a.name) })) as { id: string; name: string; siteUrl: string };
      await must("POST", `/api/seo/${s.id}/run/perf`);
      return { site: s.name, id: s.id, started: "perf", open: `/seo/${s.id}` };
    },
  },

  // ---------- mockups ----------
  {
    name: "add_mockup_lead", write: true, args: { url: "the lead's website URL", business: "business name?", name: "contact name?", email: "contact email?", phone: "phone?" },
    desc: "Add a lead to the Mockups workspace. This starts the pipeline that rebuilds the homepage.",
    summary: (a) => `Add mockup lead for ${host(pick(a, "url", "siteUrl"))}`,
    run: (a) => must("POST", "/api/leads", { url: pick(a, "url", "siteUrl"), business: str(a.business), name: str(a.name), email: str(a.email), phone: str(a.phone) }),
  },
  {
    name: "run_mockup", write: true, args: { leadId: "the lead id", from: "step key to restart from?" },
    desc: "Run (or re-run) the mockup pipeline for a lead.",
    summary: (a) => `Run the mockup pipeline for lead ${str(a.leadId)}`,
    run: (a) => must("POST", `/api/leads/${encodeURIComponent(str(a.leadId))}/run`, str(a.from) ? { from: str(a.from) } : {}),
  },

  // ---------- Lead Finder ----------
  {
    name: "start_finder_search", write: true, args: { query: "what to search on Google Maps, e.g. 'HVAC companies in Rotterdam'", max: "max results 1-120?" },
    desc: "Start a Lead Finder search on Google Maps.",
    summary: (a) => `Search Google Maps for "${str(a.query)}"`,
    run: (a) => must("POST", "/api/finder/searches", { query: str(a.query), max: a.max ? Number(a.max) : 20 }),
  },

  // ---------- maintenance ----------
  {
    name: "add_care_site", write: true, args: { siteUrl: "site URL", wpUser: "WordPress admin username", appPassword: "WordPress application password", name: "display name?", client: "client name?" },
    desc: "Add a site to the Maintenance workspace (uptime, monthly updates, health).",
    summary: (a) => `Add maintenance site ${host(pick(a, "siteUrl", "url"))}`,
    run: (a) => must("POST", "/api/care", { siteUrl: pick(a, "siteUrl", "url"), wpUser: str(a.wpUser), appPassword: str(a.appPassword), name: str(a.name), client: str(a.client) }),
  },
  {
    name: "run_care_scan", write: true, args: { site: "maintenance site id, URL or name" },
    desc: "Scan a maintenance site for available updates and security issues (read-only on the client site).",
    summary: (a) => `Scan ${str(a.site)} for updates`,
    run: async (a) => {
      const s = await findSite("care", pick(a, "site", "siteUrl", "url"));
      if (!s) throw new Error("No maintenance site matches that. Add it first with add_care_site.");
      await must("POST", `/api/care/${s.id}/scan`);
      return { scanning: s.name };
    },
  },
  {
    name: "run_care_maintenance", write: true, danger: true, args: { site: "maintenance site id, URL or name" },
    desc: "Start the full monthly maintenance run for a site: clone to staging, apply updates there, then wait for approval. Acts on a live client site.",
    summary: (a) => `Start monthly maintenance for ${str(a.site)} (staging clone + updates)`,
    run: async (a) => {
      const s = await findSite("care", pick(a, "site", "siteUrl", "url"));
      if (!s) throw new Error("No maintenance site matches that. Add it first with add_care_site.");
      await must("POST", `/api/care/${s.id}/run`);
      return { started: s.name };
    },
  },

  // ---------- communication ----------
  {
    name: "add_comms_channel", write: true, args: { name: "channel name", url: "web address of the service" },
    desc: "Add a channel to the Communication workspace (a web app like WhatsApp Web, Gmail, a webmail URL).",
    summary: (a) => `Add channel "${str(a.name)}" (${host(str(a.url))})`,
    run: (a) => must("POST", "/api/comms", { name: str(a.name), url: str(a.url) }),
  },

  // ---------- destructive ----------
  {
    name: "delete_item", write: true, danger: true, args: { workspace: "one of: seo, care, comms, finder-search, mockup", id: "the item's id" },
    desc: "Permanently delete an item and its data. Use only when the user clearly asks to delete something.",
    summary: (a) => `Delete ${str(a.workspace)} item ${str(a.id)}`,
    run: (a) => {
      const id = encodeURIComponent(str(a.id));
      const path = { seo: `/api/seo/${id}`, care: `/api/care/${id}`, comms: `/api/comms/${id}`, "finder-search": `/api/finder/searches/${id}`, mockup: `/api/leads/${id}` }[str(a.workspace)];
      if (!path) throw new Error(`Unknown workspace "${str(a.workspace)}"`);
      return must("DELETE", path);
    },
  },
];

/** A page the assistant can open for the user (used by the navigate tool and the client). */
export const PAGES: Record<string, string> = {
  mockups: "/", leads: "/leads", benchmarks: "/benchmarks", settings: "/settings/profile",
  finder: "/finder", "finder leads": "/finder/leads", builds: "/builds", "new build": "/builds/new",
  wordpress: "/wp", "new wordpress conversion": "/wp/new", seo: "/seo", "new seo site": "/seo/new",
  maintenance: "/care", "new maintenance site": "/care/new", communication: "/comms", "super admin": "/admin",
  revenue: "/admin/revenue", clients: "/admin/clients",
};

export const byName = (name: string) => TOOLS.find((t) => t.name === name);
