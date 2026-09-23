import { Router } from "express";
import { randomUUID } from "node:crypto";
import { getSettings, listEvents, listLeads, sqlite as db } from "./db.ts";
import { listProspects } from "./finder/store.ts";
import { listBuilds } from "./builds/store.ts";
import { listConversions } from "./wp/store.ts";
import { listSites as listSeoSites, readResult } from "./seo/store.ts";
import { listCareSites, readCare } from "./care/store.ts";
import type { AdminClient, AdminOverview, CareHealth, Payment, QaResult, Retainer, ServiceKind } from "../shared/types.ts";

/**
 * Super admin: reporting across every workspace, plus the money side (payments and
 * maintenance retainers), which nothing else in the app records.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, date TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS retainers (care_id TEXT PRIMARY KEY, data TEXT NOT NULL);
`);

const SERVICES: ServiceKind[] = ["mockup", "website", "wordpress", "seo", "maintenance", "hosting", "other"];

export const listPayments = (): Payment[] => (db.prepare("SELECT data FROM payments ORDER BY date DESC").all() as { data: string }[]).map((r) => JSON.parse(r.data));
const savePayment = (p: Payment) => db.prepare("INSERT INTO payments (id, date, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET date = excluded.date, data = excluded.data").run(p.id, p.date, JSON.stringify(p));
export const listRetainers = (): Retainer[] => (db.prepare("SELECT data FROM retainers").all() as { data: string }[]).map((r) => JSON.parse(r.data));
const saveRetainer = (r: Retainer) => db.prepare("INSERT INTO retainers (care_id, data) VALUES (?, ?) ON CONFLICT(care_id) DO UPDATE SET data = excluded.data").run(r.careId, JSON.stringify(r));

/** Same client across workspaces = same domain. */
export function hostKey(url: string) {
  try {
    return new URL(/^https?:\/\//.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

const dayMs = 86400000;
const inRange = (iso: string | undefined, from: number, to: number) => {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= from && t < to;
};
const month = (d: Date) => d.toISOString().slice(0, 7);

function cleanPayment(body: Record<string, unknown>, base?: Payment): Payment | string {
  const amount = Number(body.amount ?? base?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return "Enter an amount above 0";
  const date = String(body.date ?? base?.date ?? new Date().toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Use a date like 2026-09-22";
  const client = String(body.client ?? base?.client ?? "").trim().slice(0, 80);
  if (!client) return "Who paid? Enter the client";
  const service = SERVICES.includes(body.service as ServiceKind) ? (body.service as ServiceKind) : base?.service ?? "other";
  const status = body.status === "pending" ? "pending" : body.status === "paid" ? "paid" : base?.status ?? "paid";
  return {
    id: base?.id ?? randomUUID().slice(0, 8),
    date,
    client,
    domain: String(body.domain ?? base?.domain ?? "").trim() ? hostKey(String(body.domain ?? base?.domain)) : "",
    service,
    amount: Math.round(amount * 100) / 100,
    status,
    note: String(body.note ?? base?.note ?? "").slice(0, 200),
    careId: base?.careId ?? (body.careId ? String(body.careId) : undefined),
    period: base?.period ?? (body.period ? String(body.period) : undefined),
    createdAt: base?.createdAt ?? new Date().toISOString(),
  };
}

/* ---------- the overview ---------- */

function overview(days: number): AdminOverview {
  const now = Date.now();
  const to = now + 1;
  const from = days ? now - days * dayMs : 0;
  const prevFrom = days ? from - days * dayMs : 0;
  const leads = listLeads();
  const prospects = listProspects();
  const builds = listBuilds();
  const convs = listConversions();
  const seo = listSeoSites();
  const care = listCareSites();
  const payments = listPayments();
  const retainers = listRetainers().filter((r) => r.active && care.some((c) => c.id === r.careId));

  const L = leads.filter((l) => inRange(l.createdAt, from, to));
  const P = prospects.filter((p) => inRange(p.createdAt, from, to));
  const paidIn = (a: number, b: number) => payments.filter((p) => p.status === "paid" && inRange(p.date + "T12:00:00Z", a, b)).reduce((s, p) => s + p.amount, 0);

  // Weekly intake for the last 12 weeks, oldest first.
  const weeks = Array.from({ length: 12 }, (_, i) => {
    const end = now - (11 - i) * 7 * dayMs;
    const start = end - 7 * dayMs;
    return {
      label: new Date(start + dayMs).toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
      leads: leads.filter((l) => inRange(l.createdAt, start, end)).length,
      prospects: prospects.filter((p) => inRange(p.createdAt, start, end)).length,
    };
  });

  // Paid revenue per month, last 12 months.
  const months = Array.from({ length: 12 }, (_, i) => {
    const now = new Date();
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - (11 - i), 1, 12));
    const key = month(d);
    return { key, label: d.toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }), paid: payments.filter((p) => p.status === "paid" && p.date.startsWith(key)).reduce((s, p) => s + p.amount, 0) };
  });

  const byService = SERVICES.map((s) => ({ service: s, paid: payments.filter((p) => p.status === "paid" && p.service === s && inRange(p.date + "T12:00:00Z", from, to)).reduce((a, p) => a + p.amount, 0) })).filter((x) => x.paid > 0).sort((a, b) => b.paid - a.paid);

  const clients = clientRows();
  const funnel = [
    { stage: "Leads", count: clients.filter((c) => c.stages.lead).length },
    { stage: "Mockup ready", count: clients.filter((c) => c.stages.mockup).length },
    { stage: "Website built", count: clients.filter((c) => c.stages.build).length },
    { stage: "On WordPress", count: clients.filter((c) => c.stages.wordpress).length },
    { stage: "Launched (SEO)", count: clients.filter((c) => c.stages.live).length },
    { stage: "In maintenance", count: clients.filter((c) => c.stages.maintenance).length },
    { stage: "Paying", count: clients.filter((c) => c.paid > 0).length },
  ];

  const attention: AdminOverview["attention"] = [];
  for (const c of care) {
    if (c.run?.status === "waiting") attention.push({ kind: "approve", title: `${c.name}: updates tested, waiting for approval`, link: `/care/${c.id}` });
    if (c.run?.status === "failed") attention.push({ kind: "failed", title: `${c.name}: maintenance stopped`, detail: c.run.note, link: `/care/${c.id}` });
    if (c.summary?.critical) attention.push({ kind: "security", title: `${c.name}: ${c.summary.critical} high or critical vulnerabilities`, link: `/care/${c.id}?tab=security` });
    const h = readCare<CareHealth>(c.id, "health");
    if (h?.ssl && h.ssl.daysLeft < 14) attention.push({ kind: "security", title: `${c.name}: SSL certificate expires in ${h.ssl.daysLeft} days`, link: `/care/${c.id}?tab=health` });
    if (h?.domain && h.domain.daysLeft < 30) attention.push({ kind: "money", title: `${c.name}: domain renews in ${h.domain.daysLeft} days`, link: `/care/${c.id}?tab=health` });
  }
  for (const s of seo) {
    const bad = readResult<QaResult>(s.id, "qa")?.forms.filter((f) => f.test?.ok === false).length ?? 0;
    if (bad) attention.push({ kind: "failed", title: `${s.name}: ${bad} form${bad === 1 ? "" : "s"} failing`, link: `/seo/${s.id}` });
  }
  for (const l of leads.filter((x) => x.status === "failed" || x.status === "needs_review").slice(0, 5)) attention.push({ kind: l.status === "failed" ? "failed" : "approve", title: `${l.business || hostKey(l.url)}: mockup ${l.status === "failed" ? "failed" : "needs review"}`, link: `/leads/${l.id}` });
  for (const b of builds.filter((x) => x.status === "failed" || x.status === "needs_review")) attention.push({ kind: b.status === "failed" ? "failed" : "approve", title: `${b.business}: build ${b.status === "failed" ? "failed" : "needs review"}`, link: `/builds/${b.id}` });
  for (const c of convs.filter((x) => x.status === "failed" || x.status === "awaiting_approval")) attention.push({ kind: c.status === "failed" ? "failed" : "approve", title: `${c.business}: WordPress ${c.status === "failed" ? "conversion failed" : "page waiting for approval"}`, link: `/wp/${c.id}` });
  for (const p of payments.filter((x) => x.status === "pending" && now - new Date(x.date).getTime() > 30 * dayMs)) attention.push({ kind: "money", title: `${p.client}: ${p.amount} unpaid for ${Math.floor((now - new Date(p.date).getTime()) / dayMs)} days`, link: "/admin/revenue" });

  const runs = db.prepare("SELECT COUNT(*) as n, COALESCE(SUM(cost_usd), 0) as cost FROM runs WHERE at >= ?").get(new Date(from).toISOString()) as { n: number; cost: number };
  const updatesApplied = care.reduce((a, c) => a + c.history.filter((h) => inRange(h.finishedAt, from, to)).reduce((s, h) => s + h.updated, 0), 0);
  const uptimes = care.map((c) => readCare<CareHealth>(c.id, "health")?.uptime.days30).filter((x): x is number => typeof x === "number");

  return {
    range: days,
    currency: getSettings().currency,
    revenue: {
      paid: paidIn(from, to),
      paidPrev: days ? paidIn(prevFrom, from) : null,
      pending: payments.filter((p) => p.status === "pending").reduce((s, p) => s + p.amount, 0),
      mrr: retainers.reduce((s, r) => s + r.fee, 0),
      allTime: payments.filter((p) => p.status === "paid").reduce((s, p) => s + p.amount, 0),
      months,
      byService,
    },
    leads: {
      total: L.length,
      prev: days ? leads.filter((l) => inRange(l.createdAt, prevFrom, from)).length : null,
      bySource: (["elementor", "meta", "manual", "maps"] as const).map((s) => ({ source: s, count: L.filter((l) => l.source === s).length })),
      ready: L.filter((l) => l.status === "ready").length,
      review: L.filter((l) => l.status === "needs_review").length,
      failed: L.filter((l) => l.status === "failed").length,
      prospects: P.length,
      prospectsContactable: P.filter((p) => p.emails.length || p.whatsapp === "business_profile" || p.whatsapp === "site_link").length,
      prospectsToMockup: P.filter((p) => p.mockupLeadId).length,
      weeks,
    },
    work: {
      builds: builds.filter((b) => inRange(b.createdAt, from, to)).length,
      buildsReady: builds.filter((b) => b.status === "ready").length,
      buildsActive: builds.filter((b) => ["queued", "running", "paused"].includes(b.status)).length,
      pagesBuilt: builds.reduce((a, b) => a + b.pages.filter((p) => p.status === "done").length, 0),
      conversions: convs.length,
      conversionsDone: convs.filter((c) => c.status === "done").length,
      wpPagesApproved: convs.reduce((a, c) => a + c.pages.filter((p) => p.status === "approved").length, 0),
      seoSites: seo.length,
      seoSignedOff: seo.filter((s) => s.qaSignedOff).length,
      seoFixed: seo.filter((s) => s.runs.fixes?.status === "done").length,
      careSites: care.length,
      careUpdates: updatesApplied,
      careWaiting: care.filter((c) => c.run?.status === "waiting").length,
      careVulnerable: care.filter((c) => (c.summary?.critical ?? 0) > 0).length,
      uptime: uptimes.length ? Math.round((uptimes.reduce((a, b) => a + b, 0) / uptimes.length) * 100) / 100 : null,
    },
    usage: { jobs: runs.n, apiCost: Math.round(runs.cost * 100) / 100 },
    funnel,
    attention: attention.slice(0, 20),
    activity: listEvents(15),
    topClients: clients.filter((c) => c.paid > 0).sort((a, b) => b.paid - a.paid).slice(0, 5),
  };
}

/* ---------- clients: one row per domain, across every workspace ---------- */

export function clientRows(): AdminClient[] {
  const rows = new Map<string, AdminClient>();
  const row = (url: string, name: string, at: string) => {
    const key = hostKey(url);
    if (!key) return null;
    let r = rows.get(key);
    if (!r) {
      r = { key, name: name || key, url, stages: { lead: false, mockup: false, build: false, wordpress: false, live: false, maintenance: false }, links: {}, lastActivity: at, paid: 0, pending: 0, retainer: 0, source: "" };
      rows.set(key, r);
    }
    if (at > r.lastActivity) r.lastActivity = at;
    if (name && (r.name === key || !r.name)) r.name = name;
    return r;
  };
  for (const l of listLeads()) {
    const r = row(l.url, l.business, l.createdAt);
    if (!r) continue;
    r.stages.lead = true;
    r.source ||= l.source;
    if (l.status === "ready" || l.status === "needs_review") r.stages.mockup = true;
    r.links.lead = `/leads/${l.id}`;
  }
  for (const b of listBuilds()) {
    const r = row(b.url, b.business, b.createdAt);
    if (!r) continue;
    if (b.status === "ready") r.stages.build = true;
    r.links.build = `/builds/${b.id}`;
  }
  for (const c of listConversions()) {
    // Conversions are keyed by the lead's domain through their build.
    const b = listBuilds().find((x) => x.id === c.buildId);
    const r = row(b?.url ?? c.siteUrl, c.business, c.createdAt);
    if (!r) continue;
    if (c.status === "done") r.stages.wordpress = true;
    r.links.wordpress = `/wp/${c.id}`;
  }
  for (const s of listSeoSites()) {
    const r = row(s.siteUrl, s.name, s.createdAt);
    if (!r) continue;
    r.stages.live = true;
    r.links.seo = `/seo/${s.id}`;
  }
  const retainers = listRetainers();
  for (const c of listCareSites()) {
    const r = row(c.siteUrl, c.client || c.name, c.history[0]?.finishedAt ?? c.createdAt);
    if (!r) continue;
    r.stages.maintenance = true;
    r.links.care = `/care/${c.id}`;
    const ret = retainers.find((x) => x.careId === c.id && x.active);
    if (ret) r.retainer += ret.fee;
  }
  for (const p of listPayments()) {
    const r = p.domain ? rows.get(p.domain) ?? row(p.domain, p.client, p.date) : [...rows.values()].find((x) => x.name.toLowerCase() === p.client.toLowerCase()) ?? row(p.client, p.client, p.date);
    if (!r) continue;
    if (p.status === "paid") r.paid += p.amount;
    else r.pending += p.amount;
  }
  return [...rows.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

/* ---------- routes ---------- */

export const admin = Router();

admin.get("/overview", (req, res) => {
  const days = Math.max(0, Math.min(3650, Number(req.query.range ?? 30) || 0));
  res.json(overview(days));
});

admin.get("/clients", (_req, res) => res.json(clientRows()));

admin.get("/payments", (_req, res) => res.json({ payments: listPayments(), retainers: listRetainers(), currency: getSettings().currency, sites: listCareSites().map((c) => ({ id: c.id, name: c.name, client: c.client, siteUrl: c.siteUrl })) }));

admin.post("/payments", (req, res) => {
  const p = cleanPayment(req.body ?? {});
  if (typeof p === "string") return res.status(400).json({ error: p });
  savePayment(p);
  res.json(p);
});

admin.put("/payments/:id", (req, res) => {
  const base = listPayments().find((p) => p.id === req.params.id);
  if (!base) return res.sendStatus(404);
  const p = cleanPayment(req.body ?? {}, base);
  if (typeof p === "string") return res.status(400).json({ error: p });
  savePayment(p);
  res.json(p);
});

admin.delete("/payments/:id", (req, res) => {
  db.prepare("DELETE FROM payments WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

/** Monthly maintenance fee per site. 0 turns the retainer off. */
admin.put("/retainers/:careId", (req, res) => {
  const site = listCareSites().find((c) => c.id === req.params.careId);
  if (!site) return res.sendStatus(404);
  const fee = Math.max(0, Math.round(Number(req.body?.fee ?? 0) * 100) / 100);
  const prev = listRetainers().find((r) => r.careId === site.id);
  saveRetainer({ careId: site.id, fee, active: fee > 0, since: prev?.since ?? new Date().toISOString().slice(0, 10) });
  res.json(listRetainers());
});

/** Add this month's retainer invoices (as pending) for every active retainer that doesn't have one yet. */
admin.post("/retainers/bill", (_req, res) => {
  const period = new Date().toISOString().slice(0, 7);
  const sites = listCareSites();
  const existing = listPayments();
  let n = 0;
  for (const r of listRetainers().filter((x) => x.active)) {
    const s = sites.find((x) => x.id === r.careId);
    if (!s || existing.some((p) => p.careId === r.careId && p.period === period)) continue;
    const p = cleanPayment({ amount: r.fee, date: `${period}-01`, client: s.client || s.name, domain: s.siteUrl, service: "maintenance", status: "pending", note: `Maintenance ${period}`, careId: r.careId, period });
    if (typeof p !== "string") {
      savePayment(p);
      n++;
    }
  }
  res.json({ added: n });
});
