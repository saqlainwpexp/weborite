import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Workflow, ArrowRight, Loader2 } from "lucide-react";
import { api, usePoll, timeAgo } from "../../lib/api";
import type { Campaign } from "../../../../shared/types";

const STATUS_LABEL: Record<Campaign["status"], string> = {
  scraping: "Finding businesses", generating: "Generating mockups", ready: "Ready to send", armed: "Armed", sending: "Sending", done: "Done", failed: "Failed",
};

function CampaignRow({ c }: { c: Campaign }) {
  const ready = c.items.filter((i) => i.mockupStatus === "ready" || i.mockupStatus === "review").length;
  return (
    <Link to={`/campaigns/${c.id}`} className="camp-row card">
      <div className="camp-row-main">
        <div className="camp-row-title">{c.prompt}</div>
        <div className="camp-row-note muted">{c.note}</div>
      </div>
      <div className="camp-row-meta">
        <span className={`camp-pill ${c.status}`}>{STATUS_LABEL[c.status]}</span>
        <span className="muted">{c.items.length ? `${ready}/${c.items.length} mockups` : "—"}</span>
        <span className="muted">{timeAgo(c.createdAt)}</span>
        <ArrowRight className="camp-row-arrow" />
      </div>
    </Link>
  );
}

export default function Campaigns() {
  const { data, reload } = usePoll<Campaign[]>("/api/campaigns", 4000);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const nav = useNavigate();

  async function start() {
    const p = prompt.trim();
    if (!p || busy) return;
    setBusy(true);
    setErr("");
    try {
      const c = await api<Campaign>("/api/campaigns", { method: "POST", json: { prompt: p } });
      setPrompt("");
      reload();
      nav(`/campaigns/${c.id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1><Workflow className="page-head-icon" /> Automations</h1>
          <p className="muted">Give a prompt. It scrapes the businesses, auto-generates a mockup for each from the design library, then waits for you to send.</p>
        </div>
      </div>

      <div className="card camp-new">
        <label className="camp-new-label">New campaign</label>
        <div className="camp-new-row">
          <input
            className="input camp-new-input"
            placeholder="e.g. 20 HVAC companies in Austin"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && start()}
            disabled={busy}
          />
          <button className="btn btn-ink" onClick={start} disabled={busy || !prompt.trim()}>
            {busy ? <Loader2 className="spin" /> : <Workflow />} Start campaign
          </button>
        </div>
        {err && <div className="camp-err">{err}</div>}
        <div className="camp-new-hint muted">It will find up to the number you name (default 20), scrape phone/email/WhatsApp, and build a mockup for each keeping their real brand and photos.</div>
      </div>

      <div className="camp-list">
        {data === null ? (
          <p className="muted">Loading…</p>
        ) : data.length === 0 ? (
          <p className="muted">No campaigns yet. Start one above.</p>
        ) : (
          data.map((c) => <CampaignRow key={c.id} c={c} />)
        )}
      </div>
    </div>
  );
}
