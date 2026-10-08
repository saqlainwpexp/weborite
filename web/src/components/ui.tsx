import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, BellRing, CheckCircle2, Circle, Loader2, UserPlus, XCircle, Sparkles } from "lucide-react";
import type { EventItem, LeadStatus, StepStatus } from "../../../shared/types";
import { api } from "../lib/api";
import { W_DOT, W_PATH, W_RATIO, W_VIEWBOX, wStroke } from "../../../shared/logo";

export function Logo({ width = 28 }: { width?: number }) {
  return <WMark width={width} />;
}

/** The Weborite "W" mark (shared/logo.ts), in the current text colour. */
export function WMark({ width }: { width: number }) {
  return (
    <svg width={width} height={Math.round(width * W_RATIO)} viewBox={W_VIEWBOX} fill="none" aria-hidden="true">
      <path d={W_PATH} stroke="currentColor" strokeWidth={wStroke(width)} strokeLinecap="square" />
      <rect {...W_DOT} fill="currentColor" />
    </svg>
  );
}

const STATUS_LABEL: Record<LeadStatus, string> = {
  queued: "Queued",
  running: "In progress",
  ready: "Ready",
  needs_review: "Needs review",
  failed: "Failed",
  paused: "Paused",
  stopped: "Stopped",
};

export function StatusPill({ status }: { status: LeadStatus }) {
  return (
    <span className={`status ${status}`}>
      <span className="dot" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function StepIcon({ status }: { status: StepStatus }) {
  if (status === "done") return <CheckCircle2 className="ok" aria-label="Done" />;
  if (status === "running") return <Loader2 className="spin" aria-label="Running" style={{ color: "var(--accent)" }} />;
  if (status === "failed") return <XCircle className="bad" aria-label="Failed" />;
  return <Circle className="muted" aria-label="Pending" style={{ color: "var(--faint)" }} />;
}

export function EventIcon({ kind }: { kind: EventItem["kind"] }) {
  if (kind === "lead") return <UserPlus />;
  if (kind === "ready") return <Sparkles />;
  if (kind === "review") return <AlertTriangle />;
  if (kind === "failed") return <XCircle />;
  return <BellRing />;
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function AddLeadModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [form, setForm] = useState({ url: "", business: "", name: "", email: "", phone: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ id: string; duplicate: boolean }>("/api/leads", { method: "POST", json: form });
      onCreated(r.id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="New mockup" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="input-group">
          <label htmlFor="f-url">Website URL</label>
          <input id="f-url" className="input" placeholder="https://" value={form.url} onChange={set("url")} autoFocus required />
        </div>
        <div className="input-group">
          <label htmlFor="f-biz">Business name</label>
          <input id="f-biz" className="input" value={form.business} onChange={set("business")} />
        </div>
        <div className="form-row">
          <div className="input-group">
            <label htmlFor="f-name">Contact name</label>
            <input id="f-name" className="input" value={form.name} onChange={set("name")} />
          </div>
          <div className="input-group">
            <label htmlFor="f-email">Email</label>
            <input id="f-email" className="input" type="email" value={form.email} onChange={set("email")} />
          </div>
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className="foot" style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}>
          <button type="button" className="btn btn-chip" onClick={onClose}>Cancel</button>
          <button className="btn btn-ink btn-wide" disabled={busy}>{busy ? "Adding…" : "Create mockup"}</button>
        </div>
      </form>
    </Modal>
  );
}
