import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  AlertTriangle, CheckCircle2, Clock, Eye, GitBranch, Loader2, Mail, MoreHorizontal, Pause, Play, Plus, Send, Tag, Trash2, Workflow as WorkflowIcon, X, XCircle, Zap,
} from "lucide-react";
import type { WfEdge, WfEnrollment, WfNode, WfNodeKind, WorkflowSummary } from "../../../../shared/types";
import { api, timeAgo, usePoll } from "../../lib/api";

type ListData = { workflows: WorkflowSummary[]; outreach: { ready: boolean; from: string; cap: number; sent24h: number; replies: { on: boolean; at: string; error: string; found: number } } };
type Detail = { workflow: WorkflowSummary; enrollments: WfEnrollment[]; problems: string[] };

const NODE_W = 230;
const NODE_H = 86;
const OX = 420; // canvas origin, so nodes can sit left of x = 0
const OY = 40;
const CANVAS_W = 2600;
const CANVAS_H = 2000;

const META: Record<WfNodeKind, { label: string; icon: ReactNode; cls: string }> = {
  trigger: { label: "Trigger", icon: <Zap />, cls: "wf-trigger" },
  email: { label: "Send email", icon: <Mail />, cls: "wf-email" },
  wait: { label: "Wait", icon: <Clock />, cls: "wf-wait" },
  condition: { label: "Condition", icon: <GitBranch />, cls: "wf-condition" },
  action: { label: "Action", icon: <Tag />, cls: "wf-action" },
};

const DEFAULTS: Record<Exclude<WfNodeKind, "trigger">, WfNode["config"]> = {
  email: { subject: "", body: "", attachMockup: true },
  wait: { mode: "time", amount: 2, unit: "days" },
  condition: { field: "has_email", op: "is_true" },
  action: { type: "create_mockup" },
};

const FIELDS: { value: string; label: string; type: "bool" | "number" | "text" }[] = [
  { value: "has_email", label: "Has an email address", type: "bool" },
  { value: "has_website", label: "Has a website", type: "bool" },
  { value: "has_whatsapp", label: "Is on WhatsApp", type: "bool" },
  { value: "mockup_ready", label: "Mockup is ready", type: "bool" },
  { value: "replied", label: "Has replied", type: "bool" },
  { value: "reply_sentiment", label: "Reply sentiment", type: "text" },
  { value: "fit_score", label: "Fit score", type: "number" },
  { value: "rating", label: "Google rating", type: "number" },
  { value: "reviews", label: "Number of reviews", type: "number" },
  { value: "has_label", label: "Labels", type: "text" },
  { value: "category", label: "Category", type: "text" },
];
const OPS: Record<"bool" | "number" | "text", { value: string; label: string }[]> = {
  bool: [{ value: "is_true", label: "is yes" }, { value: "is_false", label: "is no" }],
  number: [{ value: "gt", label: "is more than" }, { value: "lt", label: "is less than" }],
  text: [{ value: "contains", label: "contains" }, { value: "not_contains", label: "doesn't contain" }],
};
const ACTIONS: { value: string; label: string; hint: string }[] = [
  { value: "create_mockup", label: "Create mockup card", hint: "Designs a new homepage for the business (a card in Mockups)" },
  { value: "add_label", label: "Add label", hint: "Tag the business, e.g. “call”, “emailed”, “hot”" },
  { value: "remove_label", label: "Remove label", hint: "" },
  { value: "notify", label: "Notify me", hint: "Shows in your activity feed" },
  { value: "mark_dead", label: "Mark as dead", hint: "Labels the business “dead” and ends it here" },
  { value: "stop", label: "Stop the workflow", hint: "This business leaves the workflow here" },
];
const VARS = ["business", "city", "category", "website", "rating", "reviews", "top_issue", "fit_summary", "my_name", "my_company", "my_phone", "my_email"];

function describe(n: WfNode): { title: string; sub: string } {
  const c = n.config;
  switch (n.kind) {
    case "trigger":
      if (c.event === "label") return { title: `Label added: ${c.label || "…"}`, sub: "When a business gets this label" };
      if (c.event === "mockup_ready") return { title: "Mockup ready", sub: "When a Lead Finder mockup finishes" };
      return { title: c.niche ? `${c.niche}${c.location ? ` in ${c.location}` : ""}` : "New search", sub: c.niche ? `Search up to ${c.max || 20} businesses${c.anySearch ? " · + your searches" : ""}` : "Click to set niche and location" };
    case "email":
      return { title: String(c.subject || "Send email"), sub: c.subject ? `To the business${c.attachMockup ? " · mockup attached" : ""}` : "Click to write the email" };
    case "wait":
      return c.mode === "mockup" ? { title: "Wait for the mockup", sub: `Up to ${c.timeoutHours || 6} hours` }
        : c.mode === "reply" ? { title: "Wait for a reply", sub: `Up to ${c.amount || 2} ${c.unit || "days"}` }
        : { title: `Wait ${c.amount || 1} ${c.unit || "minutes"}`, sub: "Then continue to the next step" };
    case "condition": {
      const f = FIELDS.find((x) => x.value === c.field);
      const op = f && OPS[f.type].find((o) => o.value === c.op);
      return { title: f ? `${f.label} ${op?.label ?? ""}${f.type !== "bool" ? ` ${c.value ?? ""}` : ""}` : "Condition", sub: "Yes / no" };
    }
    case "action": {
      const a = ACTIONS.find((x) => x.value === c.type);
      return { title: `${a?.label ?? "Action"}${c.label ? `: ${c.label}` : ""}`, sub: a?.hint || "Click to configure" };
    }
  }
}

const uid = () => Math.random().toString(36).slice(2, 8);

/** "in 3h", "in 2d": when a waiting step picks up again. */
function until(iso: string) {
  const s = Math.max(0, (new Date(iso).getTime() - Date.now()) / 1000);
  return s < 60 ? "soon" : s < 3600 ? `in ${Math.round(s / 60)}m` : s < 86400 ? `in ${Math.round(s / 3600)}h` : `in ${Math.round(s / 86400)}d`;
}

/* ---------- page ---------- */

export default function Workflows() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, reload } = usePoll<ListData>("/api/automations", 5000);
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);

  // The sidebar's "New workflow" button links here with ?new=1.
  useEffect(() => {
    if (params.get("new")) {
      setCreating(true);
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  useEffect(() => {
    if (!id && !params.get("new") && data?.workflows.length) nav(`/automations/${data.workflows[0].id}`, { replace: true });
  }, [id, data, nav]);

  async function remove(w: WorkflowSummary) {
    if (!confirm(`Delete “${w.name}”? Businesses in it stop where they are. Emails already sent stay sent.`)) return;
    await api(`/api/automations/${w.id}`, { method: "DELETE" });
    setMenu(null);
    await reload();
    if (id === w.id) nav("/automations");
  }

  return (
    <>
      <div className="title-row">
        <div>
          <h1 className="page-title">Automations</h1>
          <p className="muted" style={{ marginTop: 8 }}>Build a workflow once: find businesses, make mockups, email them and follow up on their own.</p>
        </div>
        <div className="actions">
          <Link className="btn btn-white" to="/campaigns">Quick campaigns</Link>
          <button className="btn btn-ink" onClick={() => setCreating(true)}><Plus />New workflow</button>
        </div>
      </div>

      {data && !data.outreach.ready && (
        <div className="banner"><AlertTriangle />Emails need an outreach mailbox. <Link to="/settings/integrations">Set it up in Settings → Integrations</Link>: the address and SMTP login you send from.</div>
      )}

      <div className="wf-layout">
        <aside className="wf-list">
          <h5>Workflows</h5>
          {!data && <p className="muted">Loading…</p>}
          {data && !data.workflows.length && <p className="muted" style={{ fontSize: 14 }}>No workflows yet. Start with the ready-made one: search, mockup, email, follow-up.</p>}
          {data?.workflows.map((w) => (
            <div key={w.id} className={`wf-card${w.id === id ? " on" : ""}`} onClick={() => nav(`/automations/${w.id}`)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && nav(`/automations/${w.id}`)}>
              <div className="wf-card-top">
                <b>{w.name}</b>
                <button type="button" className="icon-btn" aria-label="Workflow menu" onClick={(e) => { e.stopPropagation(); setMenu(menu === w.id ? null : w.id); }}><MoreHorizontal /></button>
                {menu === w.id && (
                  <div className="wf-menu" onClick={(e) => e.stopPropagation()}>
                    <button type="button" onClick={() => void remove(w)}><Trash2 />Delete</button>
                  </div>
                )}
              </div>
              <span className="muted">{w.nodes.length} steps · {w.counts.enrolled} enrolled{w.counts.emailsSent ? ` · ${w.counts.emailsSent} emailed` : ""}{w.counts.replied ? ` · ${w.counts.replied} replied` : ""}</span>
              <span className={`wf-pill ${w.status}`}><span className="dot" />{w.status}</span>
            </div>
          ))}
          {data && <p className="muted wf-sent">{data.outreach.sent24h} of {data.outreach.cap} emails sent in the last 24 hours</p>}
          {data && (data.outreach.replies.on ? (
            <p className={`wf-sent ${data.outreach.replies.error ? "bad" : "muted"}`}>
              {data.outreach.replies.error ? `Couldn't read replies: ${data.outreach.replies.error}` : `Tracks replies · inbox checked ${data.outreach.replies.at ? timeAgo(data.outreach.replies.at) : "soon"}`}
              {" "}<button type="button" className="wf-link" onClick={async () => { try { const r = await api<{ found: number }>("/api/automations/replies/check", { method: "POST" }); alert(r.found ? `${r.found} new ${r.found === 1 ? "reply" : "replies"} found.` : "No new replies."); } catch (e) { alert((e as Error).message); } void reload(); }}>Check now</button>
            </p>
          ) : <p className="muted wf-sent"><Link to="/settings/integrations">Add the replies inbox</Link> to stop following up when someone replies.</p>)}
        </aside>

        {id ? <Editor key={id} id={id} onChange={reload} /> : (
          <div className="card card-lg wf-empty">
            <WorkflowIcon />
            <h3>Your first workflow</h3>
            <p className="muted">Pick a niche and a location. The workflow finds the businesses, makes a mockup for each, emails the ones with an address and follows up three days later. You can change every step.</p>
            <button className="btn btn-ink" onClick={() => setCreating(true)}><Plus />Create it</button>
          </div>
        )}
      </div>

      {creating && <NewWorkflow onClose={() => setCreating(false)} onCreated={async (wid) => { setCreating(false); await reload(); nav(`/automations/${wid}`); }} />}
    </>
  );
}

function NewWorkflow({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState({ name: "", template: "starter", niche: "", location: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    setErr("");
    try {
      const name = f.name || ((f.template === "starter" || f.template === "followup") && f.niche ? `${f.niche}${f.location ? ` in ${f.location}` : ""}` : "New workflow");
      const w = await api<WorkflowSummary>("/api/automations", { method: "POST", json: { ...f, name } });
      onCreated(w.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal wf-new" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="New workflow">
        <div className="card-head"><h3 className="card-title">New workflow</h3><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><X /></button></div>
        <div className="wf-templates">
          {[["starter", "Find, mockup, email, follow up", "Search a niche in a location, create a mockup for each business, email it, follow up after 3 days"], ["followup", "Find, mockup, email, track replies", "Like the starter, but tracks replies: a positive reply pings you to start a build; otherwise one follow-up, then marks the business dead"], ["blank", "Start from scratch", "Just the trigger: add your own steps"]].map(([v, t, h]) => (
            <label key={v} className={`wf-template${f.template === v ? " on" : ""}`}>
              <input type="radio" name="tpl" checked={f.template === v} onChange={() => setF({ ...f, template: v })} />
              <b>{t}</b><small className="muted">{h}</small>
            </label>
          ))}
        </div>
        {(f.template === "starter" || f.template === "followup") && (
          <div className="wf-form-row">
            <label className="wf-field"><span>Niche</span><input className="input" autoFocus value={f.niche} onChange={(e) => setF({ ...f, niche: e.target.value })} placeholder="e.g. dentists" /></label>
            <label className="wf-field"><span>Location</span><input className="input" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="e.g. Manchester" /></label>
          </div>
        )}
        <label className="wf-field"><span>Name (optional)</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={f.niche ? `${f.niche}${f.location ? ` in ${f.location}` : ""}` : "New workflow"} /></label>
        {err && <p className="error-text">{err}</p>}
        <div className="wf-actions-row"><button type="button" className="btn btn-white" onClick={onClose}>Cancel</button><button type="button" className="btn btn-ink" disabled={busy} onClick={() => void create()}>{busy ? <Loader2 className="spin" /> : <Plus />}Create</button></div>
      </div>
    </div>
  );
}

/* ---------- editor ---------- */

type Drag = { kind: "move"; id: string; dx: number; dy: number; moved?: boolean } | { kind: "link"; from: string; branch?: "yes" | "no"; x: number; y: number };

function Editor({ id, onChange }: { id: string; onChange: () => void }) {
  const { data, reload } = usePoll<Detail>(`/api/automations/${id}`, 4000);
  const [nodes, setNodes] = useState<WfNode[] | null>(null);
  const [edges, setEdges] = useState<WfEdge[]>([]);
  const [name, setName] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [selEdge, setSelEdge] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState<"" | "save" | "run" | "status">("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [tab, setTab] = useState<"canvas" | "activity">("canvas");
  const canvas = useRef<HTMLDivElement>(null);

  // Load once per workflow; later polls only refresh counts and activity, never the graph being edited.
  useEffect(() => {
    if (data && nodes === null) {
      setNodes(data.workflow.nodes);
      setEdges(data.workflow.edges);
      setName(data.workflow.name);
      setProblems(data.problems);
    }
  }, [data, nodes]);

  const save = useCallback(async (quiet = true) => {
    if (!nodes) return;
    setSaving((s) => s || "save");
    try {
      const r = await api<{ problems: string[] }>(`/api/automations/${id}`, { method: "PUT", json: { name, nodes, edges } });
      setProblems(r.problems);
      setDirty(false);
      if (!quiet) setMsg({ ok: true, text: "Saved" });
      onChange();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setSaving((s) => (s === "save" ? "" : s));
    }
  }, [id, name, nodes, edges, onChange]);

  // Autosave a moment after the last change.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => void save(), 900);
    return () => clearTimeout(t);
  }, [dirty, save]);

  const change = (fn: () => void) => {
    fn();
    setDirty(true);
  };
  const updateNode = (nid: string, patch: Partial<WfNode> | ((n: WfNode) => WfNode)) =>
    change(() => setNodes((ns) => ns!.map((n) => (n.id === nid ? (typeof patch === "function" ? patch(n) : { ...n, ...patch }) : n))));
  const deleteNode = (nid: string) => {
    if (nodes?.find((n) => n.id === nid)?.kind === "trigger") return;
    change(() => {
      setNodes((ns) => ns!.filter((n) => n.id !== nid));
      setEdges((es) => {
        // Keep the chain joined: whatever led here now leads to what came after.
        const into = es.filter((e) => e.to === nid);
        const out = es.find((e) => e.from === nid);
        return [...es.filter((e) => e.to !== nid && e.from !== nid), ...(out ? into.map((e) => ({ ...e, to: out.to })) : [])];
      });
    });
    setSel(null);
  };
  const link = (from: string, to: string, branch?: "yes" | "no") => {
    if (from === to || nodes?.find((n) => n.id === to)?.kind === "trigger") return;
    change(() => setEdges((es) => [...es.filter((e) => !(e.from === from && (branch ? e.branch === branch : true))), branch ? { from, to, branch } : { from, to }]));
  };

  function addNode(kind: Exclude<WfNodeKind, "trigger">, at?: { x: number; y: number }) {
    const nid = `${kind}-${uid()}`;
    const anchor = nodes?.find((n) => n.id === sel) ?? nodes?.reduce((a, b) => (b.y > a.y ? b : a));
    const pos = at ?? { x: anchor?.x ?? 60, y: (anchor?.y ?? 0) + 150 };
    change(() => {
      setNodes((ns) => [...ns!, { id: nid, kind, x: Math.round(pos.x / 10) * 10, y: Math.round(pos.y / 10) * 10, config: { ...DEFAULTS[kind] } }]);
      // Added from the toolbar: link it after the selected (or last) step if that step has a free exit.
      if (!at && anchor && anchor.kind !== "condition" && !edges.some((e) => e.from === anchor.id)) setEdges((es) => [...es, { from: anchor.id, to: nid }]);
    });
    setSel(nid);
  }

  const toCanvas = (clientX: number, clientY: number) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: clientX - r.left + canvas.current!.scrollLeft - OX, y: clientY - r.top + canvas.current!.scrollTop - OY };
  };

  function onPointerMove(e: RPointerEvent) {
    if (!drag) return;
    const p = toCanvas(e.clientX, e.clientY);
    if (drag.kind === "move") {
      const x = Math.round((p.x - drag.dx) / 10) * 10;
      const y = Math.round((p.y - drag.dy) / 10) * 10;
      const cur = nodes?.find((n) => n.id === drag.id);
      if (cur && (cur.x !== x || cur.y !== y)) {
        setNodes((ns) => ns!.map((n) => (n.id === drag.id ? { ...n, x, y } : n)));
        if (!drag.moved) setDrag({ ...drag, moved: true });
      }
    } else setDrag({ ...drag, x: p.x, y: p.y });
  }
  function onPointerUp(e: RPointerEvent) {
    if (!drag) return;
    if (drag.kind === "move") {
      if (drag.moved) setDirty(true);
    }
    else {
      const target = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest("[data-node]")?.getAttribute("data-node");
      if (target) link(drag.from, target, drag.branch);
    }
    setDrag(null);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && !(e.target as HTMLElement).closest("input, textarea, select")) {
        if (sel) deleteNode(sel);
        else if (selEdge !== null) change(() => setEdges((es) => es.filter((_, i) => i !== selEdge)));
        setSelEdge(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Centre the view on the workflow the first time it loads.
  useEffect(() => {
    if (nodes && canvas.current && canvas.current.scrollLeft === 0) {
      const minX = Math.min(...nodes.map((n) => n.x));
      canvas.current.scrollLeft = Math.max(0, minX + OX - 60);
    }
  }, [nodes === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const en of data?.enrollments ?? []) if ((en.status === "active" || en.status === "waiting") && en.nodeId) m[en.nodeId] = (m[en.nodeId] ?? 0) + 1;
    return m;
  }, [data]);

  if (!data || !nodes) return <div className="card card-lg wf-editor"><p className="muted">Loading…</p></div>;
  const w = data.workflow;
  const selected = nodes.find((n) => n.id === sel) ?? null;

  const outPoint = (n: WfNode, branch?: "yes" | "no") => ({ x: n.x + OX + (branch === "yes" ? NODE_W * 0.28 : branch === "no" ? NODE_W * 0.72 : NODE_W / 2), y: n.y + OY + NODE_H });
  const inPoint = (n: WfNode) => ({ x: n.x + OX + NODE_W / 2, y: n.y + OY });
  const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dy = Math.max(40, Math.abs(b.y - a.y) / 2);
    return `M${a.x},${a.y} C${a.x},${a.y + dy} ${b.x},${b.y - dy} ${b.x},${b.y}`;
  };

  async function act(kind: "run" | "status", status?: "active" | "paused") {
    setSaving(kind);
    setMsg(null);
    try {
      await save();
      if (kind === "run") {
        const r = await api<{ note: string }>(`/api/automations/${id}/run`, { method: "POST" });
        setMsg({ ok: true, text: r.note });
      } else {
        await api(`/api/automations/${id}/status`, { method: "POST", json: { status } });
        setMsg({ ok: true, text: status === "active" ? "Active: businesses enter when the trigger happens." : "Paused. Businesses stay where they are until you resume." });
      }
      await reload();
      onChange();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setSaving("");
    }
  }

  return (
    <div className="card wf-editor">
      <header className="wf-head">
        <div className="wf-title">
          <input className="wf-name" value={name} aria-label="Workflow name" onChange={(e) => change(() => setName(e.target.value))} />
          <span className="muted">{nodes.length} steps · {w.counts.enrolled} enrolled · {w.counts.emailsSent} emailed{w.counts.replied ? ` · ${w.counts.replied} replied` : ""}{dirty || saving === "save" ? " · saving…" : ""}</span>
        </div>
        <span className={`wf-pill ${w.status}`}><span className="dot" />{w.status === "active" ? "Active" : w.status === "paused" ? "Paused" : "Draft"}</span>
        <div className="wf-palette" aria-label="Add a step">
          <span className="muted">Drag to canvas:</span>
          {(["email", "wait", "condition", "action"] as const).map((k) => (
            <button key={k} type="button" draggable className={`wf-chip ${META[k].cls}`} onDragStart={(e) => e.dataTransfer.setData("text/wf-kind", k)} onClick={() => addNode(k)} title={`Add ${META[k].label.toLowerCase()} (or drag it onto the canvas)`}>
              {META[k].icon}{k === "email" ? "Email" : META[k].label}
            </button>
          ))}
        </div>
        <div className="wf-head-actions">
          {w.status === "active"
            ? <button type="button" className="btn btn-white" disabled={Boolean(saving)} onClick={() => void act("status", "paused")}>{saving === "status" ? <Loader2 className="spin" /> : <Pause />}Pause</button>
            : w.activatedAt && <button type="button" className="btn btn-white" disabled={Boolean(saving)} onClick={() => void act("status", "active")}>{saving === "status" ? <Loader2 className="spin" /> : <Play />}Resume</button>}
          <button type="button" className="btn btn-ink" disabled={Boolean(saving)} onClick={() => void act("run")}>{saving === "run" ? <Loader2 className="spin" /> : <Play />}Save & Run</button>
        </div>
      </header>

      {msg && <div className={`banner wf-banner${msg.ok ? "" : " err"}`} style={msg.ok ? { background: "#eaf4ee", color: "#2f6f4a" } : undefined}>{msg.ok ? <CheckCircle2 /> : <XCircle />}{msg.text}<button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setMsg(null)}><X /></button></div>}
      {problems.length > 0 && <div className="wf-problems"><AlertTriangle />{problems.join(" · ")}</div>}

      <nav className="tabs wf-tabs">
        <button type="button" className={`tab tab-btn${tab === "canvas" ? " on" : ""}`} onClick={() => setTab("canvas")}>Canvas</button>
        <button type="button" className={`tab tab-btn${tab === "activity" ? " on" : ""}`} onClick={() => setTab("activity")}>Activity ({w.counts.enrolled})</button>
      </nav>

      {tab === "canvas" ? (
        <div className="wf-stage">
          <div
            ref={canvas}
            className="wf-canvas"
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerDown={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("wf-plane")) { setSel(null); setSelEdge(null); } }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const k = e.dataTransfer.getData("text/wf-kind") as Exclude<WfNodeKind, "trigger">;
              if (!k) return;
              e.preventDefault();
              const p = toCanvas(e.clientX, e.clientY);
              addNode(k, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 });
            }}
          >
            <div className="wf-plane" style={{ width: CANVAS_W, height: CANVAS_H }}>
              <svg className="wf-edges" width={CANVAS_W} height={CANVAS_H}>
                {edges.map((e, i) => {
                  const a = nodes.find((n) => n.id === e.from);
                  const b = nodes.find((n) => n.id === e.to);
                  if (!a || !b) return null;
                  const d = curve(outPoint(a, e.branch), inPoint(b));
                  return (
                    <g key={`${e.from}-${e.to}-${e.branch ?? ""}`} className={`wf-edge${selEdge === i ? " on" : ""}${e.branch ? ` ${e.branch}` : ""}`} onPointerDown={(ev) => { ev.stopPropagation(); setSelEdge(i); setSel(null); }}>
                      <path d={d} className="hit" />
                      <path d={d} className="line" />
                    </g>
                  );
                })}
                {drag?.kind === "link" && (() => {
                  const a = nodes.find((n) => n.id === drag.from);
                  return a ? <path className="wf-edge-draft" d={curve(outPoint(a, drag.branch), { x: drag.x + OX, y: drag.y + OY })} /> : null;
                })()}
              </svg>
              {selEdge !== null && edges[selEdge] && (() => {
                const e = edges[selEdge];
                const a = nodes.find((n) => n.id === e.from);
                const b = nodes.find((n) => n.id === e.to);
                if (!a || !b) return null;
                const p1 = outPoint(a, e.branch);
                const p2 = inPoint(b);
                return <button type="button" className="wf-edge-del" style={{ left: (p1.x + p2.x) / 2, top: (p1.y + p2.y) / 2 }} onClick={() => { change(() => setEdges((es) => es.filter((_, i) => i !== selEdge))); setSelEdge(null); }}><X />Remove link</button>;
              })()}

              {nodes.map((n) => {
                const m = META[n.kind];
                const d = describe(n);
                const on = sel === n.id;
                return (
                  <div
                    key={n.id}
                    data-node={n.id}
                    className={`wf-node ${m.cls}${on ? " on" : ""}`}
                    style={{ left: n.x + OX, top: n.y + OY, width: NODE_W, height: NODE_H }}
                    onPointerDown={(e) => {
                      if ((e.target as HTMLElement).closest(".wf-handle")) return;
                      e.stopPropagation();
                      setSel(n.id);
                      setSelEdge(null);
                      const p = toCanvas(e.clientX, e.clientY);
                      setDrag({ kind: "move", id: n.id, dx: p.x - n.x, dy: p.y - n.y });
                      (e.currentTarget.parentElement?.parentElement as HTMLElement)?.setPointerCapture?.(e.pointerId);
                    }}
                  >
                    {on && n.kind !== "trigger" && <button type="button" className="wf-node-del" onPointerDown={(e) => e.stopPropagation()} onClick={() => deleteNode(n.id)}><Trash2 />Delete node</button>}
                    {n.kind !== "trigger" && <span className="wf-handle in" />}
                    <span className="wf-node-ico">{m.icon}</span>
                    <div className="wf-node-text">
                      <small>{m.label}</small>
                      <b>{d.title}</b>
                      <span>{d.sub}</span>
                    </div>
                    {counts[n.id] ? <span className="wf-node-count" title="Businesses at this step now">{counts[n.id]}</span> : null}
                    {n.kind === "condition" ? (
                      <>
                        {(["yes", "no"] as const).map((b) => (
                          <span key={b} className={`wf-handle out ${b}`} title={`Drag to the step for “${b}”`} onPointerDown={(e) => { e.stopPropagation(); const p = toCanvas(e.clientX, e.clientY); setDrag({ kind: "link", from: n.id, branch: b, x: p.x, y: p.y }); (canvas.current as HTMLElement).setPointerCapture?.(e.pointerId); }}>
                            <em>{b}</em>
                          </span>
                        ))}
                      </>
                    ) : !(n.kind === "action" && n.config.type === "stop") && (
                      <span className="wf-handle out" title="Drag to the next step" onPointerDown={(e) => { e.stopPropagation(); const p = toCanvas(e.clientX, e.clientY); setDrag({ kind: "link", from: n.id, x: p.x, y: p.y }); (canvas.current as HTMLElement).setPointerCapture?.(e.pointerId); }} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          {selected && <Panel key={selected.id} node={selected} workflowId={id} onChange={(config) => updateNode(selected.id, (n) => ({ ...n, config }))} onClose={() => setSel(null)} onDelete={() => deleteNode(selected.id)} />}
        </div>
      ) : (
        <Activity enrollments={data.enrollments} nodes={nodes} />
      )}
    </div>
  );
}

/* ---------- config panel ---------- */

function Panel({ node, workflowId, onChange, onClose, onDelete }: { node: WfNode; workflowId: string; onChange: (c: WfNode["config"]) => void; onClose: () => void; onDelete: () => void }) {
  const c = node.config;
  const set = (k: string, v: string | number | boolean) => onChange({ ...c, [k]: v });
  const body = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState<{ subject: string; body: string; business: string; to?: string; sent?: string } | null>(null);
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const insertVar = (v: string) => {
    const t = body.current;
    const text = String(c.body ?? "");
    const at = t ? t.selectionStart : text.length;
    set("body", `${text.slice(0, at)}{{${v}}}${text.slice(at)}`);
  };
  async function doPreview(send: boolean) {
    setBusy(true);
    setErr("");
    try {
      setPreview(await api(`/api/automations/${workflowId}/preview`, { method: "POST", json: { config: c, send, to: testTo } }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const field = FIELDS.find((f) => f.value === c.field) ?? FIELDS[0];
  return (
    <aside className="wf-panel" aria-label="Step settings">
      <div className="wf-panel-head">
        <span className={`wf-node-ico ${META[node.kind].cls}`}>{META[node.kind].icon}</span>
        <b>{META[node.kind].label}</b>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><X /></button>
      </div>
      <div className="wf-panel-body">
        {node.kind === "trigger" && (
          <>
            <label className="wf-field"><span>Starts when</span>
              <select className="input" value={String(c.event ?? "search")} onChange={(e) => set("event", e.target.value)}>
                <option value="search">A search finishes (niche + location)</option>
                <option value="label">A business gets a label</option>
                <option value="mockup_ready">A Lead Finder mockup is ready</option>
              </select>
            </label>
            {(c.event ?? "search") === "search" && (
              <>
                <label className="wf-field"><span>Niche</span><input className="input" value={String(c.niche ?? "")} onChange={(e) => set("niche", e.target.value)} placeholder="e.g. roofers" /></label>
                <label className="wf-field"><span>Location</span><input className="input" value={String(c.location ?? "")} onChange={(e) => set("location", e.target.value)} placeholder="e.g. Leeds" /></label>
                <label className="wf-field"><span>Businesses per search</span><input className="input" type="number" min={1} max={120} value={Number(c.max ?? 20)} onChange={(e) => set("max", Number(e.target.value))} /></label>
                <label className="wf-check"><input type="checkbox" checked={Boolean(c.anySearch)} onChange={(e) => set("anySearch", e.target.checked)} /> Also run for every search I start in Lead Finder</label>
                <p className="muted wf-hint">“Save & Run” starts this search. Every business it finds enters the workflow once the search (and its website checks) finish.</p>
              </>
            )}
            {c.event === "label" && <label className="wf-field"><span>Label</span><input className="input" value={String(c.label ?? "")} onChange={(e) => set("label", e.target.value.toLowerCase())} placeholder="e.g. interested" /></label>}
            {c.event === "mockup_ready" && <p className="muted wf-hint">Every Lead Finder business whose mockup finishes after you activate this enters the workflow.</p>}
          </>
        )}

        {node.kind === "email" && (
          <>
            <label className="wf-field"><span>Subject</span><input className="input" value={String(c.subject ?? "")} onChange={(e) => set("subject", e.target.value)} placeholder="A new website idea for {{business}}" /></label>
            <label className="wf-field"><span>Message</span><textarea ref={body} className="input" rows={10} value={String(c.body ?? "")} onChange={(e) => set("body", e.target.value)} placeholder={"Hi {{business}} team,\n\n…"} /></label>
            <div className="wf-vars">{VARS.map((v) => <button key={v} type="button" className="wf-var" onClick={() => insertVar(v)}>{`{{${v}}}`}</button>)}</div>
            <label className="wf-check"><input type="checkbox" checked={Boolean(c.attachMockup)} onChange={(e) => set("attachMockup", e.target.checked)} /> Attach a preview of the mockup (when it's ready)</label>
            <p className="muted wf-hint">Sent to the first email address found for the business, from your outreach mailbox, one every 45 seconds within your daily limit. Businesses without an address skip this step. When a business replies, every workflow stops for it.</p>
            <div className="wf-actions-row">
              <button type="button" className="btn btn-white btn-sm" disabled={busy} onClick={() => void doPreview(false)}><Eye />Preview</button>
              <input className="input" style={{ flex: 1, minWidth: 120 }} type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="Your email" aria-label="Send a test to" />
              <button type="button" className="btn btn-white btn-sm" disabled={busy} onClick={() => void doPreview(true)}>{busy ? <Loader2 className="spin" /> : <Send />}Test</button>
            </div>
            {err && <p className="error-text">{err}</p>}
            {preview && (
              <div className="wf-preview">
                <small className="muted">{preview.sent ? `Sent to ${preview.sent}` : `Preview with ${preview.business}${preview.to ? ` (${preview.to})` : ""}`}</small>
                <b>{preview.subject}</b>
                <pre>{preview.body}</pre>
              </div>
            )}
          </>
        )}

        {node.kind === "wait" && (
          <>
            <label className="wf-field"><span>Wait</span>
              <select className="input" value={String(c.mode ?? "time")} onChange={(e) => set("mode", e.target.value)}>
                <option value="time">For a set time</option>
                <option value="mockup">Until the mockup is ready</option>
                <option value="reply">Until they reply</option>
              </select>
            </label>
            {(c.mode ?? "time") === "mockup" ? (
              <label className="wf-field"><span>Give up after (hours)</span><input className="input" type="number" min={1} value={Number(c.timeoutHours ?? 6)} onChange={(e) => set("timeoutHours", Number(e.target.value))} /></label>
            ) : (
              <>
                <div className="wf-form-row">
                  <label className="wf-field"><span>{(c.mode ?? "time") === "reply" ? "Wait up to" : "Amount"}</span><input className="input" type="number" min={1} value={Number(c.amount ?? ((c.mode ?? "time") === "reply" ? 2 : 1))} onChange={(e) => set("amount", Number(e.target.value))} /></label>
                  <label className="wf-field"><span>Unit</span>
                    <select className="input" value={String(c.unit ?? ((c.mode ?? "time") === "reply" ? "days" : "minutes"))} onChange={(e) => set("unit", e.target.value)}>
                      <option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option>
                    </select>
                  </label>
                </div>
                {(c.mode ?? "time") === "reply" && <p className="muted wf-hint">Continues the moment they reply, or after this long if they don't. Follow a reply with a “Reply sentiment” condition to branch on it.</p>}
              </>
            )}
          </>
        )}

        {node.kind === "condition" && (
          <>
            <label className="wf-field"><span>If</span>
              <select className="input" value={field.value} onChange={(e) => { const f = FIELDS.find((x) => x.value === e.target.value)!; onChange({ field: f.value, op: OPS[f.type][0].value, value: f.type === "number" ? 3 : "" }); }}>
                {FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </label>
            <label className="wf-field"><span>Is</span>
              <select className="input" value={String(c.op)} onChange={(e) => set("op", e.target.value)}>
                {OPS[field.type].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            {field.type !== "bool" && <label className="wf-field"><span>Value</span><input className="input" type={field.type === "number" ? "number" : "text"} value={String(c.value ?? "")} onChange={(e) => set("value", field.type === "number" ? Number(e.target.value) : e.target.value)} placeholder={field.value === "reply_sentiment" ? "positive" : undefined} /></label>}
            {field.value === "reply_sentiment" && <p className="muted wf-hint">Values: <b>positive</b>, <b>negative</b> or <b>neutral</b>. Put this after a “Wait until they reply” step.</p>}
            <p className="muted wf-hint">Drag from the <b>yes</b> dot to the step for businesses that match, and from <b>no</b> to the step for the rest. An unlinked branch ends the workflow for that business.</p>
          </>
        )}

        {node.kind === "action" && (
          <>
            <label className="wf-field"><span>Do this</span>
              <select className="input" value={String(c.type ?? "create_mockup")} onChange={(e) => onChange({ type: e.target.value })}>
                {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </label>
            <p className="muted wf-hint">{ACTIONS.find((a) => a.value === c.type)?.hint}</p>
            {(c.type === "add_label" || c.type === "remove_label") && <label className="wf-field"><span>Label</span><input className="input" value={String(c.label ?? "")} onChange={(e) => set("label", e.target.value.toLowerCase())} placeholder="e.g. emailed" /></label>}
            {c.type === "notify" && <label className="wf-field"><span>Message</span><input className="input" value={String(c.text ?? "")} onChange={(e) => set("text", e.target.value)} placeholder="{{business}} has no email: call {{phone}}" /></label>}
            {c.type === "add_label" && <p className="muted wf-hint">The label “do-not-contact” stops every workflow emailing that business.</p>}
          </>
        )}
      </div>
      {node.kind !== "trigger" && <div className="wf-panel-foot"><button type="button" className="btn btn-ghost btn-sm" onClick={onDelete}><Trash2 />Delete step</button></div>}
    </aside>
  );
}

/* ---------- activity ---------- */

function Activity({ enrollments, nodes }: { enrollments: WfEnrollment[]; nodes: WfNode[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!enrollments.length) return <div className="wf-activity"><p className="muted">No businesses have entered this workflow yet. Press “Save & Run”, or activate it and wait for the trigger.</p></div>;
  const stepName = (nid: string | null) => {
    const n = nodes.find((x) => x.id === nid);
    return n ? describe(n).title : "Finished";
  };
  return (
    <div className="wf-activity">
      <div className="table-wrap"><table className="table">
        <thead><tr><th>Business</th><th>Status</th><th>Step</th><th>Last update</th></tr></thead>
        <tbody>
          {enrollments.map((e) => {
            const last = e.log.at(-1);
            return (
              <Fragment key={e.id}>
                <tr className="wf-row" onClick={() => setOpen(open === e.id ? null : e.id)}>
                  <td><b>{e.business}</b></td>
                  <td><span className={`wf-pill ${e.status}`}><span className="dot" />{e.status === "waiting" ? `waiting · ${until(e.wakeAt)}` : e.status}</span></td>
                  <td>{e.status === "done" || e.status === "stopped" || e.status === "replied" ? "—" : stepName(e.nodeId)}</td>
                  <td className={last && !last.ok ? "bad" : "muted"}>{last ? `${last.text} · ${timeAgo(last.at)}` : `Enrolled ${timeAgo(e.enrolledAt)}`}</td>
                </tr>
                {open === e.id && (
                  <tr className="wf-log-row"><td colSpan={4}>
                    <ol className="wf-log">{e.log.map((l, i) => <li key={i} className={l.ok ? "" : "bad"}><span className="muted mono">{l.at.slice(5, 16).replace("T", " ")}</span> {l.text}</li>)}</ol>
                  </td></tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table></div>
    </div>
  );
}
