import { randomUUID } from "node:crypto";
import { sqlite as db } from "../db.ts";
import type { WfEnrollment, Workflow, WorkflowSummary } from "../../shared/types.ts";

db.exec(`
  CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS wf_enrollments (
    id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, prospect_id TEXT NOT NULL, status TEXT NOT NULL, wake_at TEXT NOT NULL, data TEXT NOT NULL,
    UNIQUE (workflow_id, prospect_id)
  );
  CREATE INDEX IF NOT EXISTS wf_enrollments_due ON wf_enrollments(status, wake_at);
  CREATE TABLE IF NOT EXISTS wf_sends (at TEXT NOT NULL, workflow_id TEXT NOT NULL, prospect_id TEXT NOT NULL, email TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS wf_replies (email TEXT NOT NULL, prospect_id TEXT NOT NULL, at TEXT NOT NULL, subject TEXT NOT NULL, PRIMARY KEY (email, prospect_id));
`);
// Added later: how the reply reads (positive / negative / neutral), so workflows can branch on it.
try { db.exec("ALTER TABLE wf_replies ADD COLUMN sentiment TEXT NOT NULL DEFAULT ''"); } catch { /* column already exists */ }

const id = () => randomUUID().slice(0, 8);
const now = () => new Date().toISOString();

/** A new workflow starts with the trigger node on the canvas. */
export function createWorkflow(name: string): Workflow {
  const w: Workflow = {
    id: id(), name: name || "Untitled workflow", status: "draft",
    nodes: [{ id: "trigger", kind: "trigger", x: 80, y: 80, config: { event: "search", niche: "", location: "", max: 20, anySearch: false } }],
    edges: [], createdAt: now(), updatedAt: now(), activatedAt: "", searches: [], seenSearches: [],
  };
  db.prepare("INSERT INTO workflows (id, created_at, data) VALUES (?, ?, ?)").run(w.id, w.createdAt, JSON.stringify(w));
  return w;
}

export const getWorkflow = (wid: string): Workflow | null => {
  const r = db.prepare("SELECT data FROM workflows WHERE id = ?").get(wid) as { data: string } | undefined;
  return r ? JSON.parse(r.data) : null;
};
export const listWorkflows = (): Workflow[] =>
  (db.prepare("SELECT data FROM workflows ORDER BY created_at DESC").all() as { data: string }[]).map((r) => JSON.parse(r.data));
export const saveWorkflow = (w: Workflow) => db.prepare("UPDATE workflows SET data = ? WHERE id = ?").run(JSON.stringify({ ...w, updatedAt: now() }), w.id);
export function deleteWorkflow(wid: string) {
  db.prepare("DELETE FROM wf_enrollments WHERE workflow_id = ?").run(wid);
  db.prepare("DELETE FROM workflows WHERE id = ?").run(wid);
}

/* ---------- enrollments: one business going through one workflow ---------- */

/** Enroll a business once per workflow; returns null when it's already in. */
export function enroll(workflowId: string, prospectId: string, business: string, firstNode: string | null): WfEnrollment | null {
  const e: WfEnrollment = { id: id(), workflowId, prospectId, business, nodeId: firstNode, status: "active", wakeAt: now(), enrolledAt: now(), updatedAt: now(), log: [] };
  const r = db.prepare("INSERT OR IGNORE INTO wf_enrollments (id, workflow_id, prospect_id, status, wake_at, data) VALUES (?, ?, ?, ?, ?, ?)")
    .run(e.id, workflowId, prospectId, e.status, e.wakeAt, JSON.stringify(e));
  return r.changes ? e : null;
}

export function saveEnrollment(e: WfEnrollment) {
  e.updatedAt = now();
  e.log = e.log.slice(-60);
  db.prepare("UPDATE wf_enrollments SET status = ?, wake_at = ?, data = ? WHERE id = ?").run(e.status, e.wakeAt, JSON.stringify(e), e.id);
}

export const isEnrolled = (workflowId: string, prospectId: string) =>
  Boolean(db.prepare("SELECT 1 FROM wf_enrollments WHERE workflow_id = ? AND prospect_id = ?").get(workflowId, prospectId));

/** Total enrollments ever made, across every workflow (the demo caps this). */
export const countEnrollments = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM wf_enrollments").get() as { n: number }).n;

/** Enrollments ready for their next step, in active workflows only (paused ones keep their place). */
export function dueEnrollments(workflowIds: string[], limit = 50): WfEnrollment[] {
  if (!workflowIds.length) return [];
  const marks = workflowIds.map(() => "?").join(",");
  return (db.prepare(`SELECT data FROM wf_enrollments WHERE workflow_id IN (${marks}) AND status IN ('active', 'waiting') AND wake_at <= ? ORDER BY wake_at LIMIT ?`).all(...workflowIds, now(), limit) as { data: string }[]).map((r) => JSON.parse(r.data));
}

export const listEnrollments = (workflowId: string, limit = 200): WfEnrollment[] =>
  (db.prepare("SELECT data FROM wf_enrollments WHERE workflow_id = ? ORDER BY wake_at DESC LIMIT ?").all(workflowId, limit) as { data: string }[]).map((r) => JSON.parse(r.data));

/* ---------- sends: the daily cap counts every outreach email, across workflows ---------- */

export function recordSend(workflowId: string, prospectId: string, email: string) {
  db.prepare("INSERT INTO wf_sends (at, workflow_id, prospect_id, email) VALUES (?, ?, ?, ?)").run(now(), workflowId, prospectId, email.toLowerCase());
}
export const sentLast24h = () => (db.prepare("SELECT COUNT(*) AS n FROM wf_sends WHERE at > ?").get(new Date(Date.now() - 86400000).toISOString()) as { n: number }).n;
export const lastSendAt = () => (db.prepare("SELECT MAX(at) AS at FROM wf_sends").get() as { at: string | null }).at;
/** Anyone already emailed by any workflow in the last 30 days isn't emailed again by another one. */
export const emailedRecently = (email: string, exceptWorkflow: string) =>
  Boolean(db.prepare("SELECT 1 FROM wf_sends WHERE email = ? AND workflow_id != ? AND at > ?").get(email.toLowerCase(), exceptWorkflow, new Date(Date.now() - 30 * 86400000).toISOString()));

/* ---------- replies: a business that wrote back is never emailed again by a workflow ---------- */

/** Everyone emailed since a date: who, which business, and when first. */
export const sendsSince = (since: string) =>
  db.prepare("SELECT email, prospect_id AS prospectId, MIN(at) AS at FROM wf_sends WHERE at > ? GROUP BY email, prospect_id").all(since) as { email: string; prospectId: string; at: string }[];
export const hasReplied = (prospectId: string) => Boolean(db.prepare("SELECT 1 FROM wf_replies WHERE prospect_id = ?").get(prospectId));
/** How the business's reply read: "positive" | "negative" | "neutral" | "" (no reply). */
export const replySentiment = (prospectId: string): string =>
  (db.prepare("SELECT sentiment FROM wf_replies WHERE prospect_id = ? ORDER BY at DESC LIMIT 1").get(prospectId) as { sentiment: string } | undefined)?.sentiment ?? "";
export function recordReply(email: string, prospectId: string, at: string, subject: string, sentiment = "") {
  return db.prepare("INSERT OR IGNORE INTO wf_replies (email, prospect_id, at, subject, sentiment) VALUES (?, ?, ?, ?, ?)").run(email, prospectId, at, subject.slice(0, 200), sentiment).changes > 0;
}
export const replyCount = (workflowId: string) =>
  (db.prepare("SELECT COUNT(DISTINCT r.prospect_id) AS n FROM wf_replies r JOIN wf_sends s ON s.prospect_id = r.prospect_id WHERE s.workflow_id = ?").get(workflowId) as { n: number }).n;
/** Enrollments still running for a business, in any workflow. */
export const runningFor = (prospectId: string): WfEnrollment[] =>
  (db.prepare("SELECT data FROM wf_enrollments WHERE prospect_id = ? AND status IN ('active', 'waiting')").all(prospectId) as { data: string }[]).map((r) => JSON.parse(r.data));

export function summarize(w: Workflow): WorkflowSummary {
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM wf_enrollments WHERE workflow_id = ? GROUP BY status").all(w.id) as { status: string; n: number }[];
  const n = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  const sent = (db.prepare("SELECT COUNT(*) AS n FROM wf_sends WHERE workflow_id = ?").get(w.id) as { n: number }).n;
  return { ...w, counts: { enrolled: rows.reduce((a, r) => a + r.n, 0), active: n("active"), waiting: n("waiting"), done: n("done") + n("stopped") + n("replied"), failed: n("failed"), emailsSent: sent, replied: replyCount(w.id) } };
}
