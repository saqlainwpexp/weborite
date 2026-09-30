import { Router } from "express";
import { addEvent, getSettings } from "../db.ts";
import type { Prospect, WfEdge, WfNode, Workflow } from "../../shared/types.ts";
import { createSearch, getProspect, listProspects } from "../finder/store.ts";
import { enqueueSearch } from "../finder/queue.ts";
import { sendMail, smtpProbe } from "../golive/smtp.ts";
import { demoCap, demoLeft, demoLimitMessage, useDemoAllowance } from "../license/index.ts";
import { DEMO_RESULTS } from "../../shared/demo.ts";
import { describeNode, outreach, outreachReady, render, vars } from "./engine.ts";
import { createWorkflow, deleteWorkflow, enroll, getWorkflow, listEnrollments, listWorkflows, saveWorkflow, sentLast24h, summarize } from "./store.ts";

export const automations = Router();

const KINDS = ["trigger", "email", "wait", "condition", "action"];

/** The starter flow: find businesses, make a mockup for each, email the ones with an address, follow up once. */
function starter(w: Workflow, niche: string, location: string) {
  const n = (id: string, kind: WfNode["kind"], x: number, y: number, config: WfNode["config"]): WfNode => ({ id, kind, x, y, config });
  w.nodes = [
    n("trigger", "trigger", 60, 60, { event: "search", niche, location, max: 20, anySearch: false }),
    n("mockup", "action", 60, 210, { type: "create_mockup" }),
    n("waitmock", "wait", 60, 360, { mode: "mockup", timeoutHours: 6 }),
    n("hasemail", "condition", 60, 510, { field: "has_email", op: "is_true" }),
    n("email1", "email", -160, 690, {
      subject: "A new website idea for {{business}}",
      body: "Hi {{business}} team,\n\nI was looking at businesses in {{city}} and put together a quick redesign of your website to show what's possible. A preview is attached.\n\n{{top_issue}}\n\nIf you'd like the full version, just reply to this email.\n\nBest,\n{{my_name}}\n{{my_company}} · {{my_phone}}",
      attachMockup: true,
    }),
    n("label", "action", 280, 690, { type: "add_label", label: "call" }),
    n("wait3", "wait", -160, 840, { mode: "time", amount: 3, unit: "days" }),
    n("email2", "email", -160, 990, {
      subject: "Re: A new website idea for {{business}}",
      body: "Hi again,\n\nJust checking you saw the redesign I made for {{business}}. Happy to send the full version or answer any questions.\n\n{{my_name}}",
      attachMockup: false,
    }),
  ];
  w.edges = [
    { from: "trigger", to: "mockup" }, { from: "mockup", to: "waitmock" }, { from: "waitmock", to: "hasemail" },
    { from: "hasemail", to: "email1", branch: "yes" }, { from: "hasemail", to: "label", branch: "no" },
    { from: "email1", to: "wait3" }, { from: "wait3", to: "email2" },
  ];
}

/** Keeps the graph sane: known node kinds, one trigger, edges between existing nodes, one exit per branch. */
function cleanGraph(nodes: unknown, edges: unknown): { nodes: WfNode[]; edges: WfEdge[] } | string {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return "Send nodes and edges";
  const out: WfNode[] = [];
  for (const raw of nodes.slice(0, 200) as Record<string, unknown>[]) {
    const kind = String(raw?.kind ?? "");
    const id = String(raw?.id ?? "").replace(/[^\w-]/g, "").slice(0, 40);
    if (!KINDS.includes(kind) || !id || out.some((x) => x.id === id)) continue;
    const config: WfNode["config"] = {};
    for (const [k, v] of Object.entries((raw.config ?? {}) as Record<string, unknown>)) {
      if (["string", "number", "boolean"].includes(typeof v)) config[k.slice(0, 40)] = typeof v === "string" ? v.slice(0, 8000) : (v as number | boolean);
    }
    out.push({ id, kind: kind as WfNode["kind"], x: Math.round(Number(raw.x) || 0), y: Math.round(Number(raw.y) || 0), config });
  }
  if (out.filter((n) => n.kind === "trigger").length !== 1) return "A workflow has exactly one trigger";
  const ids = new Set(out.map((n) => n.id));
  const es: WfEdge[] = [];
  for (const raw of edges as Record<string, unknown>[]) {
    const from = String(raw?.from ?? "");
    const to = String(raw?.to ?? "");
    const branch = raw?.branch === "yes" || raw?.branch === "no" ? raw.branch : undefined;
    if (!ids.has(from) || !ids.has(to) || from === to) continue;
    if (out.find((n) => n.id === to)?.kind === "trigger") continue;
    const isCond = out.find((n) => n.id === from)?.kind === "condition";
    if (isCond && !branch) continue;
    // One way out of each node (per branch for conditions): a new link replaces the old one.
    const i = es.findIndex((e) => e.from === from && (isCond ? e.branch === branch : true));
    const edge: WfEdge = isCond ? { from, to, branch } : { from, to };
    if (i >= 0) es[i] = edge;
    else es.push(edge);
  }
  return { nodes: out, edges: es };
}

/** Problems that would stop the workflow doing what it's meant to. */
function problems(w: Workflow) {
  const list: string[] = [];
  const trig = w.nodes.find((n) => n.kind === "trigger")!;
  if (trig.config.event === "label" && !trig.config.label) list.push("The trigger needs a label");
  if (!w.edges.some((e) => e.from === trig.id)) list.push("Connect the trigger to the first step");
  for (const n of w.nodes) {
    if (n.kind === "email" && (!n.config.subject || !n.config.body)) list.push(`“${describeNode(n)}” needs a subject and a message`);
    if (n.kind === "action" && ["add_label", "remove_label"].includes(String(n.config.type)) && !n.config.label) list.push("A label step has no label");
    if (n.kind !== "trigger" && !w.edges.some((e) => e.to === n.id)) list.push(`“${describeNode(n)}” isn't connected: nothing leads to it`);
  }
  if (w.nodes.some((n) => n.kind === "email") && !outreachReady()) list.push("Emails wait until the outreach mailbox is set up in Settings → Integrations");
  return list;
}

automations.get("/", (_req, res) => {
  const o = outreach();
  res.json({ workflows: listWorkflows().map(summarize), outreach: { ready: outreachReady(o), from: o.fromEmail, cap: o.cap, sent24h: sentLast24h() } });
});

automations.post("/", (req, res) => {
  const w = createWorkflow(String(req.body?.name ?? "").trim().slice(0, 80));
  if (req.body?.template === "starter") {
    starter(w, String(req.body?.niche ?? "").slice(0, 80), String(req.body?.location ?? "").slice(0, 80));
    saveWorkflow(w);
  }
  res.json(summarize(w));
});

automations.get("/:id", (req, res) => {
  const w = getWorkflow(req.params.id);
  if (!w) return res.sendStatus(404);
  res.json({ workflow: summarize(w), enrollments: listEnrollments(w.id, 150), problems: problems(w) });
});

automations.put("/:id", (req, res) => {
  const w = getWorkflow(req.params.id);
  if (!w) return res.sendStatus(404);
  if (typeof req.body?.name === "string") w.name = req.body.name.trim().slice(0, 80) || w.name;
  if (req.body?.nodes) {
    const g = cleanGraph(req.body.nodes, req.body.edges);
    if (typeof g === "string") return res.status(400).json({ error: g });
    Object.assign(w, g);
  }
  saveWorkflow(w);
  res.json({ workflow: summarize(getWorkflow(w.id)!), problems: problems(w) });
});

automations.post("/:id/status", (req, res) => {
  const w = getWorkflow(req.params.id);
  if (!w) return res.sendStatus(404);
  const status = req.body?.status === "active" ? "active" : "paused";
  if (status === "active") {
    const p = problems(w).filter((x) => !x.startsWith("Emails wait"));
    if (p.length) return res.status(400).json({ error: p[0] });
    if (!w.activatedAt) w.activatedAt = new Date().toISOString();
  }
  w.status = status;
  saveWorkflow(w);
  addEvent({ leadId: null, kind: "info", title: `Workflow ${status === "active" ? "activated" : "paused"}`, detail: w.name });
  res.json(summarize(w));
});

/** Save & Run: activate, and for a search trigger, start the search now. */
automations.post("/:id/run", (req, res) => {
  const w = getWorkflow(req.params.id);
  if (!w) return res.sendStatus(404);
  const p = problems(w).filter((x) => !x.startsWith("Emails wait"));
  if (p.length) return res.status(400).json({ error: p[0] });
  const trig = w.nodes.find((n) => n.kind === "trigger")!;
  let note = "Active: it runs whenever the trigger happens.";
  if (trig.config.event === "search") {
    const niche = String(trig.config.niche ?? "").trim();
    const location = String(trig.config.location ?? "").trim();
    if (!niche || !location) return res.status(400).json({ error: "Enter the niche and location in the trigger" });
    if (demoLeft("searches") <= 0) return res.status(402).json({ error: demoLimitMessage("searches"), demoLimit: "searches" });
    useDemoAllowance("searches");
    const max = demoCap(Math.min(120, Math.max(1, Number(trig.config.max) || 20)), DEMO_RESULTS);
    const s = createSearch(`${niche} in ${location}`, max);
    enqueueSearch(s.id);
    w.searches.push(s.id);
    note = `Searching for ${niche} in ${location} (up to ${max}). Each business enters the workflow when the search finishes.`;
  }
  if (!w.activatedAt) w.activatedAt = new Date().toISOString();
  w.status = "active";
  saveWorkflow(w);
  addEvent({ leadId: null, kind: "info", title: "Workflow running", detail: `${w.name}: ${note}` });
  res.json({ workflow: summarize(w), note });
});

/** Put chosen Lead Finder businesses into the workflow by hand. */
automations.post("/:id/enroll", (req, res) => {
  const w = getWorkflow(req.params.id);
  if (!w) return res.sendStatus(404);
  const trig = w.nodes.find((n) => n.kind === "trigger")!;
  let n = 0;
  for (const pid of (Array.isArray(req.body?.prospectIds) ? req.body.prospectIds : []).slice(0, 500)) {
    const p = getProspect(String(pid));
    if (p && enroll(w.id, p.id, p.name, trig.id)) n++;
  }
  res.json({ enrolled: n });
});

automations.delete("/:id", (req, res) => {
  deleteWorkflow(req.params.id);
  res.json({ ok: true });
});

/** Preview an email step with a real business, or send it to yourself. */
automations.post("/:id/preview", async (req, res) => {
  const w = getWorkflow(req.params.id);
  // The panel sends the step as it is on screen, saved or not.
  const cfg = (req.body?.config && typeof req.body.config === "object" ? req.body.config : w?.nodes.find((n) => n.id === String(req.body?.nodeId))?.config) as WfNode["config"] | undefined;
  if (!w || !cfg) return res.sendStatus(404);
  const node = { config: cfg };
  const sample: Prospect = (req.body?.prospectId && getProspect(String(req.body.prospectId))) || listProspects().find((p) => p.emails.length) || listProspects()[0] || {
    id: "sample", searchId: "", source: "google_maps", placeId: "", name: "Harbour Street Bakery", category: "Bakery", phone: "+44 20 7946 0000", website: "https://example.com",
    address: "12 Harbour Street, Brighton, BN1 1AA, UK", rating: 4.6, reviews: 128, mapsUrl: "", emails: ["hello@example.com"], emailPages: [], whatsapp: "none", whatsappName: "",
    tags: [], enrichStatus: "done", createdAt: "",
  };
  const v = vars(sample);
  const o = outreach();
  const subject = render(String(node.config.subject ?? ""), v);
  const body = render(String(node.config.body ?? ""), v) + (o.footer ? `\n\n${o.footer}` : "");
  if (req.body?.send) {
    const to = String(req.body?.to || getSettings().userEmail || "").trim();
    if (!to.includes("@")) return res.status(400).json({ error: "Enter the address to send the test to" });
    if (!outreachReady(o)) return res.status(400).json({ error: "Set up the outreach mailbox in Settings → Integrations first" });
    try {
      await sendMail({ host: o.host, port: o.port, security: o.security, user: o.user, password: o.password }, { fromName: o.fromName, fromEmail: o.fromEmail, to, subject: `[Test] ${subject}`, text: body });
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
    return res.json({ sent: to, subject, body, business: sample.name });
  }
  res.json({ subject, body, business: sample.name, to: sample.emails[0] ?? "" });
});

/** Check the outreach mailbox: connect and log in, without sending. */
automations.post("/outreach/test", async (_req, res) => {
  const o = outreach();
  if (!outreachReady(o)) return res.status(400).json({ error: "Fill in the address, SMTP server and password first" });
  res.json(await smtpProbe(o.host, o.port, o.security, { user: o.user, password: o.password }));
});
