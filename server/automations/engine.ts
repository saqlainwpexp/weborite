import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { addEvent, getLead, getSettings, leadDir } from "../db.ts";
import type { Prospect, WfEnrollment, WfNode, Workflow } from "../../shared/types.ts";
import { mockupFromProspect } from "../campaigns/index.ts";
import { getProspect, listProspects, listSearches, saveProspect } from "../finder/store.ts";
import { inboxSince } from "../golive/imap.ts";
import { sendMail, type Security } from "../golive/smtp.ts";
import { DemoLimitError } from "../license/index.ts";
import { newContext } from "../pipeline/browser.ts";
import {
  dueEnrollments, emailedRecently, enroll, getWorkflow, hasReplied, isEnrolled, lastSendAt, listWorkflows, recordReply, recordSend, runningFor, saveEnrollment, saveWorkflow,
  sendsSince, sentLast24h,
} from "./store.ts";

/* ---------- outreach settings ---------- */

type Outreach = { fromName: string; fromEmail: string; host: string; port: number; security: Security; user: string; password: string; cap: number; footer: string };

export function outreach(): Outreach {
  const s = getSettings() as unknown as Record<string, string | number>;
  return {
    fromName: String(s.outreachFromName || s.userName || ""), fromEmail: String(s.outreachFromEmail || ""), host: String(s.outreachSmtpHost || ""),
    port: Number(s.outreachSmtpPort) || 465, security: (s.outreachSmtpSecurity as Security) || "ssl", user: String(s.outreachSmtpUser || s.outreachFromEmail || ""),
    password: String(s.outreachSmtpPassword || ""), cap: Number(s.outreachDailyCap) || 40, footer: String(s.outreachFooter ?? ""),
  };
}
export const outreachReady = (o = outreach()) => Boolean(o.fromEmail && o.host && o.password);

/** The inbox replies land in: the outreach mailbox over IMAP, with the same login. */
export function replyInbox() {
  const s = getSettings() as unknown as Record<string, string | number>;
  const o = outreach();
  const host = String(s.outreachImapHost || "").trim();
  return host && o.password ? { host, port: Number(s.outreachImapPort) || 993, user: o.user, password: o.password } : null;
}

/** Seconds between two outreach emails, so a batch doesn't look like a blast to spam filters. */
export const SEND_GAP_S = 45;
const RETRIES = 3;
const RETRY_MS = 5 * 60e3;

/* ---------- templates ---------- */

/** The town from a Maps address: skips the street, postcodes, state codes and the country. */
export function city(address: string) {
  const parts = address.split(",").map((x) => x.trim()).filter(Boolean);
  for (const part of parts.slice(1, -1).reverse()) {
    const cleaned = part.replace(/\b[A-Z]{1,2}\d[\dA-Z]?\s*\d[A-Z]{2}\b/g, "").replace(/\b\d{3,6}(-\d{4})?\b/g, "").replace(/\b[A-Z]{2}\b/g, "").trim();
    if (/[a-z]{2}/i.test(cleaned)) return cleaned;
  }
  return "";
}

export function vars(p: Prospect): Record<string, string> {
  const s = getSettings() as unknown as Record<string, string>;
  return {
    business: p.name, category: p.category, city: city(p.address), address: p.address, website: p.website, phone: p.phone,
    rating: p.rating != null ? String(p.rating) : "", reviews: p.reviews != null ? String(p.reviews) : "",
    fit_summary: p.fit?.summary ?? "", top_issue: p.fit?.reasons?.find((r) => r.points > 0)?.text ?? "",
    my_name: s.userName ?? "", my_company: s.studioName ?? "", my_phone: s.userPhone ?? "", my_email: String(outreach().fromEmail || s.userEmail || ""),
  };
}

export const render = (tpl: string, v: Record<string, string>) => tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => v[k] ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/** First screen of the mockup as a small JPEG, for attaching to an email. */
export async function mockupPreview(leadId: string) {
  const dir = leadDir(leadId);
  const out = join(dir, "mockup-email.jpg");
  if (existsSync(out)) return readFileSync(out);
  const html = join(dir, "mockup", "index.html");
  if (!existsSync(html)) return null;
  const ctx = await newContext({ viewport: { width: 1280, height: 860 } });
  try {
    const page = await ctx.newPage();
    await page.goto(pathToFileURL(html).href, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: out, type: "jpeg", quality: 72 });
  } finally {
    await ctx.close();
  }
  return readFileSync(out);
}

/* ---------- conditions ---------- */

export const FIELDS: Record<string, (p: Prospect) => string | number | boolean> = {
  has_email: (p) => p.emails.length > 0,
  has_website: (p) => Boolean(p.website),
  has_whatsapp: (p) => p.tags.includes("whatsapp"),
  rating: (p) => p.rating ?? 0,
  reviews: (p) => p.reviews ?? 0,
  fit_score: (p) => p.fit?.score ?? 0,
  mockup_ready: (p) => ["ready", "needs_review"].includes(getLead(p.mockupLeadId ?? "")?.status ?? ""),
  replied: (p) => hasReplied(p.id),
  has_label: (p) => (p.labels ?? []).join(","),
  category: (p) => p.category,
};

export function evaluate(p: Prospect, cfg: WfNode["config"]) {
  const get = FIELDS[String(cfg.field)];
  if (!get) return false;
  const v = get(p);
  const want = String(cfg.value ?? "");
  switch (String(cfg.op)) {
    case "is_true": return Boolean(v);
    case "is_false": return !v;
    case "gt": return Number(v) > Number(want);
    case "lt": return Number(v) < Number(want);
    case "contains": return String(v).toLowerCase().split(",").some((x) => x.trim() === want.toLowerCase().trim()) || String(v).toLowerCase().includes(want.toLowerCase());
    case "not_contains": return !String(v).toLowerCase().includes(want.toLowerCase());
    default: return false;
  }
}

/* ---------- labels ---------- */

export function addLabel(p: Prospect, label: string) {
  const l = label.trim().toLowerCase();
  if (!l) return;
  p.labels = [...new Set([...(p.labels ?? []), l])];
  p.labelsAt = { ...(p.labelsAt ?? {}), [l]: new Date().toISOString() };
  saveProspect(p);
}
export function removeLabel(p: Prospect, label: string) {
  const l = label.trim().toLowerCase();
  p.labels = (p.labels ?? []).filter((x) => x !== l);
  if (p.labelsAt) delete p.labelsAt[l];
  saveProspect(p);
}

/* ---------- graph ---------- */

const next = (w: Workflow, nodeId: string, branch?: "yes" | "no") =>
  (branch ? w.edges.find((e) => e.from === nodeId && e.branch === branch) : w.edges.find((e) => e.from === nodeId))?.to ?? null;

const waitMs = (cfg: WfNode["config"]) => Math.max(1, Number(cfg.amount) || 1) * ({ minutes: 60e3, hours: 3600e3, days: 86400e3 }[String(cfg.unit)] ?? 60e3);

export function describeNode(n: WfNode): string {
  const c = n.config;
  switch (n.kind) {
    case "trigger": return c.event === "label" ? `Label “${c.label}” added` : c.event === "mockup_ready" ? "Mockup ready" : `New search${c.niche ? `: ${c.niche}${c.location ? ` in ${c.location}` : ""}` : ""}`;
    case "email": return `Email: ${c.subject || "(no subject)"}`;
    case "wait": return c.mode === "mockup" ? "Wait for the mockup" : `Wait ${c.amount || 1} ${c.unit || "minutes"}`;
    case "condition": return `If ${c.field} ${c.op}${c.value !== undefined && c.value !== "" ? ` ${c.value}` : ""}`;
    case "action": return String(c.type).replace(/_/g, " ") + (c.label ? ` “${c.label}”` : "");
  }
}

/* ---------- one enrollment, as far as it can go now ---------- */

type Ctx = { sentThisTick: boolean };

async function step(e: WfEnrollment, w: Workflow, ctx: Ctx) {
  const log = (nodeId: string, ok: boolean, text: string) => e.log.push({ at: new Date().toISOString(), nodeId, ok, text });
  for (let hops = 0; hops < 25; hops++) {
    const node = w.nodes.find((n) => n.id === e.nodeId);
    if (!node) {
      e.status = "done";
      log(e.nodeId ?? "", true, "Finished");
      return;
    }
    const p = getProspect(e.prospectId);
    if (!p) {
      e.status = "failed";
      log(node.id, false, "The business was deleted");
      return;
    }
    const c = node.config;
    const go = (to: string | null) => {
      e.nodeId = to;
      e.status = "active";
      e.waitingOn = undefined;
      e.waitSince = undefined;
    };

    if (node.kind === "trigger") {
      go(next(w, node.id));
      continue;
    }

    if (node.kind === "wait") {
      if (e.waitingOn !== node.id) {
        e.waitingOn = node.id;
        e.waitSince = new Date().toISOString();
      }
      const since = new Date(e.waitSince!).getTime();
      if (c.mode === "mockup") {
        const lead = getLead(p.mockupLeadId ?? "");
        const ready = ["ready", "needs_review"].includes(lead?.status ?? "");
        const timedOut = Date.now() - since > (Number(c.timeoutHours) || 6) * 3600e3;
        if (ready || timedOut || !p.mockupLeadId || lead?.status === "failed") {
          log(node.id, ready, ready ? "Mockup is ready" : !p.mockupLeadId ? "No mockup to wait for (add “Create mockup” before this)" : lead?.status === "failed" ? "The mockup failed" : "Gave up waiting for the mockup");
          go(next(w, node.id));
          continue;
        }
        e.status = "waiting";
        e.wakeAt = new Date(Date.now() + 60e3).toISOString();
        return;
      }
      if (Date.now() - since >= waitMs(c)) {
        log(node.id, true, `Waited ${c.amount || 1} ${c.unit || "minutes"}`);
        go(next(w, node.id));
        continue;
      }
      e.status = "waiting";
      e.wakeAt = new Date(since + waitMs(c)).toISOString();
      return;
    }

    if (node.kind === "condition") {
      const yes = evaluate(p, c);
      log(node.id, true, `${describeNode(node)} → ${yes ? "yes" : "no"}`);
      go(next(w, node.id, yes ? "yes" : "no"));
      continue;
    }

    if (node.kind === "action") {
      const type = String(c.type);
      if (type === "stop") {
        e.status = "stopped";
        log(node.id, true, "Stopped here");
        return;
      }
      if (type === "create_mockup") {
        if (p.mockupLeadId && getLead(p.mockupLeadId)) log(node.id, true, "Already has a mockup card");
        else {
          try {
            const item = mockupFromProspect(p);
            log(node.id, true, `Mockup card created (${item.scratch ? "designed from the Maps listing" : "rebuild of the website"})`);
          } catch (err) {
            log(node.id, false, err instanceof DemoLimitError ? err.message : `Couldn't create the mockup: ${(err as Error).message}`);
          }
        }
      } else if (type === "add_label") {
        addLabel(p, String(c.label ?? ""));
        log(node.id, true, `Label “${c.label}” added`);
      } else if (type === "remove_label") {
        removeLabel(p, String(c.label ?? ""));
        log(node.id, true, `Label “${c.label}” removed`);
      } else if (type === "notify") {
        const text = render(String(c.text || "{{business}} reached this step"), vars(p));
        addEvent({ leadId: p.mockupLeadId ?? null, kind: "info", title: `${w.name}`, detail: text });
        log(node.id, true, `Notified: ${text}`);
      }
      go(next(w, node.id));
      continue;
    }

    if (node.kind === "email") {
      const to = p.emails[0];
      const skip = (why: string) => {
        log(node.id, false, `Email skipped: ${why}`);
        go(next(w, node.id));
      };
      if (!to) { skip("no email address found for this business"); continue; }
      if (hasReplied(p.id)) {
        e.status = "replied";
        log(node.id, true, "Not emailed: they already replied");
        return;
      }
      if ((p.labels ?? []).includes("do-not-contact")) { skip("labelled do-not-contact"); continue; }
      if (emailedRecently(to, w.id)) { skip("another workflow emailed this address in the last 30 days"); continue; }
      const o = outreach();
      if (!outreachReady(o)) {
        e.status = "waiting";
        e.wakeAt = new Date(Date.now() + 10 * 60e3).toISOString();
        if (e.log.at(-1)?.text !== "Waiting: set up the outreach mailbox in Settings → Integrations") log(node.id, false, "Waiting: set up the outreach mailbox in Settings → Integrations");
        return;
      }
      // One email per tick, spaced out, within the daily cap.
      const last = lastSendAt();
      const gap = last ? SEND_GAP_S * 1000 - (Date.now() - new Date(last).getTime()) : 0;
      if (ctx.sentThisTick || gap > 0) {
        e.status = "waiting";
        e.wakeAt = new Date(Date.now() + Math.max(gap, 5000)).toISOString();
        return;
      }
      if (sentLast24h() >= o.cap) {
        e.status = "waiting";
        e.wakeAt = new Date(Date.now() + 3600e3).toISOString();
        if (!e.log.at(-1)?.text.startsWith("Daily limit")) log(node.id, false, `Daily limit of ${o.cap} emails reached: continues when there's room`);
        return;
      }
      const v = vars(p);
      const body = render(String(c.body ?? ""), v) + (o.footer ? `\n\n${o.footer}` : "");
      let attachment;
      if (c.attachMockup && p.mockupLeadId) {
        const img = await mockupPreview(p.mockupLeadId).catch(() => null);
        if (img) attachment = { name: `${p.name.replace(/[^\w-]+/g, "-").slice(0, 40)}-new-website.jpg`, type: "image/jpeg", data: img };
      }
      ctx.sentThisTick = true;
      try {
        await sendMail({ host: o.host, port: o.port, security: o.security, user: o.user, password: o.password }, {
          fromName: o.fromName, fromEmail: o.fromEmail, to, subject: render(String(c.subject ?? ""), v), text: body, attachment,
        });
        recordSend(w.id, p.id, to);
        log(node.id, true, `Emailed ${to}${attachment ? " with the mockup attached" : c.attachMockup ? " (mockup not ready, sent without it)" : ""}`);
        go(next(w, node.id));
        e.wakeAt = new Date().toISOString();
      } catch (err) {
        const why = (err as Error).message;
        // Server down, timeouts and 4xx "try later" answers are temporary: try again, a few times.
        const temporary = /refused the connection|didn't answer|Timed out|closed the connection|doesn't exist in DNS|ECONNRESET|: 4\d\d\b/i.test(why);
        const tries = e.log.filter((l) => l.nodeId === node.id && !l.ok && l.text.startsWith("Email to")).length + 1;
        if (temporary && tries < RETRIES) {
          e.status = "waiting";
          e.wakeAt = new Date(Date.now() + RETRY_MS).toISOString();
          log(node.id, false, `Email to ${to} failed (try ${tries} of ${RETRIES}), retrying in ${RETRY_MS / 60000} minutes: ${why}`);
        } else {
          e.status = "failed";
          log(node.id, false, `Email to ${to} failed: ${why}`);
        }
      }
      return;
    }
  }
  e.status = "failed";
  e.log.push({ at: new Date().toISOString(), nodeId: e.nodeId ?? "", ok: false, text: "Stopped: the workflow loops without a wait" });
}

/* ---------- triggers ---------- */

function firstNode(w: Workflow) {
  return w.nodes.find((n) => n.kind === "trigger")?.id ?? null;
}

function runTriggers(w: Workflow) {
  const trig = w.nodes.find((n) => n.kind === "trigger");
  if (!trig) return;
  const c = trig.config;
  const since = w.activatedAt;
  const add = (p: Prospect) => {
    if (enroll(w.id, p.id, p.name, trig.id)) return 1;
    return 0;
  };
  let n = 0;
  if (c.event === "search") {
    for (const s of listSearches()) {
      if (w.seenSearches.includes(s.id) || s.status !== "done") continue;
      if (!(w.searches.includes(s.id) || (c.anySearch && s.createdAt >= since))) continue;
      for (const p of listProspects({ searchId: s.id })) n += add(p);
      w.seenSearches.push(s.id);
      saveWorkflow(w);
    }
  } else if (c.event === "label") {
    const l = String(c.label ?? "").toLowerCase();
    for (const p of listProspects()) if (p.labelsAt?.[l] && p.labelsAt[l] >= since && !isEnrolled(w.id, p.id)) n += add(p);
  } else if (c.event === "mockup_ready") {
    for (const p of listProspects()) {
      if (!p.mockupLeadId || isEnrolled(w.id, p.id)) continue;
      const lead = getLead(p.mockupLeadId);
      if (lead && lead.createdAt >= since && ["ready", "needs_review"].includes(lead.status)) n += add(p);
    }
  }
  if (n) addEvent({ leadId: null, kind: "info", title: `${w.name}: ${n} businesses enrolled`, detail: describeNode(trig) });
}

/* ---------- replies: stop a business's workflows when it writes back ---------- */

// Free mail domains: a reply from someone else at gmail.com isn't the business replying.
const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|gmx|mail|yandex|zoho)\./i;
const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

export const replyState: { at: string; error: string; found: number } = { at: "", error: "", found: 0 };

/** Read the inbox for mail from anyone the workflows emailed (or from their business domain), and stop them. */
export async function checkReplies() {
  const box = replyInbox();
  if (!box) return;
  const sends = sendsSince(new Date(Date.now() - 30 * 86400e3).toISOString());
  if (!sends.length) return;
  const oldest = new Date(sends.reduce((a, s) => (s.at < a ? s.at : a), sends[0].at));
  let found = 0;
  try {
    const mail = await inboxSince(box, oldest);
    for (const m of mail) {
      if (m.autoReply) continue;
      const received = m.date ? new Date(m.date) : new Date();
      for (const s of sends) {
        const same = m.from === s.email.toLowerCase();
        const sameBusiness = !same && domainOf(m.from) === domainOf(s.email) && !FREE_MAIL.test(domainOf(s.email));
        if (!same && !sameBusiness) continue;
        // Only mail that arrived after we first wrote to them counts (a day's slack for odd Date headers).
        if (!isNaN(received.getTime()) && received.getTime() < new Date(s.at).getTime() - 86400e3) continue;
        if (!recordReply(s.email.toLowerCase(), s.prospectId, received.toISOString(), m.subject)) continue;
        found++;
        const p = getProspect(s.prospectId);
        const stopped: string[] = [];
        for (const e of runningFor(s.prospectId)) {
          e.status = "replied";
          e.log.push({ at: new Date().toISOString(), nodeId: e.nodeId ?? "", ok: true, text: `Replied (${m.from}${m.subject ? `: “${m.subject.slice(0, 80)}”` : ""}): stopped` });
          saveEnrollment(e);
          stopped.push(getWorkflow(e.workflowId)?.name ?? "");
        }
        if (p) addLabel(p, "replied");
        addEvent({ leadId: p?.mockupLeadId ?? null, kind: "info", title: `${p?.name ?? s.email} replied`, detail: `${m.from}${m.subject ? `: ${m.subject}` : ""}${stopped.length ? ` · stopped in ${stopped.filter(Boolean).join(", ")}` : ""}` });
      }
    }
    replyState.error = "";
  } catch (e) {
    replyState.error = (e as Error).message.slice(0, 200);
    console.error("[replies]", e);
  }
  replyState.at = new Date().toISOString();
  replyState.found += found;
}

/* ---------- the pump ---------- */

let busy = false;
let lastTriggers = 0;
let lastReplies = 0;
/** How often the inbox is read for replies. */
export const REPLY_CHECK_MS = 3 * 60e3;

export async function tick() {
  if (busy) return;
  busy = true;
  try {
    const flows = listWorkflows().filter((w) => w.status === "active");
    if (Date.now() - lastTriggers > 20000) {
      lastTriggers = Date.now();
      for (const w of flows) {
        try {
          runTriggers(w);
        } catch (e) {
          console.error(`[workflow ${w.id} trigger]`, e);
        }
      }
    }
    // Replies first, so nobody who just wrote back gets the next email.
    if (Date.now() - lastReplies > REPLY_CHECK_MS) {
      lastReplies = Date.now();
      await checkReplies();
    }
    const ctx: Ctx = { sentThisTick: false };
    for (const e of dueEnrollments(flows.map((w) => w.id))) {
      const w = getWorkflow(e.workflowId);
      if (!w || w.status !== "active") continue;
      try {
        await step(e, w, ctx);
      } catch (err) {
        e.status = "failed";
        e.log.push({ at: new Date().toISOString(), nodeId: e.nodeId ?? "", ok: false, text: (err as Error).message.slice(0, 200) });
      }
      saveEnrollment(e);
    }
  } finally {
    busy = false;
  }
}

let timer: NodeJS.Timeout | null = null;
export function startWorkflowTimers() {
  if (timer) return;
  timer = setInterval(() => void tick(), 10000);
  setTimeout(() => void tick(), 4000);
}

export { firstNode };
