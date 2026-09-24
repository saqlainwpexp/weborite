import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ExternalLink, Send, Loader2, CheckCircle2, XCircle, Clock } from "lucide-react";
import { api, usePoll } from "../../lib/api";
import type { Campaign, CampaignItem } from "../../../../shared/types";

const MOCKUP_ICON: Record<CampaignItem["mockupStatus"], typeof Clock> = {
  ready: CheckCircle2, review: CheckCircle2, failed: XCircle, generating: Loader2, pending: Clock,
};
const MOCKUP_LABEL: Record<CampaignItem["mockupStatus"], string> = {
  ready: "Ready", review: "Needs review", failed: "Failed", generating: "Generating…", pending: "Queued",
};

export default function CampaignDetail() {
  const { id } = useParams();
  const { data: c, reload } = usePoll<Campaign>(`/api/campaigns/${id}`, 4000);
  const [busy, setBusy] = useState(false);

  if (!c) return <p className="muted">Loading…</p>;
  const ready = c.items.filter((i) => i.mockupStatus === "ready" || i.mockupStatus === "review").length;

  async function arm() {
    setBusy(true);
    try {
      await api(`/api/campaigns/${id}/arm`, { method: "POST", json: {} });
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <Link to="/campaigns" className="back-link"><ArrowLeft /> Automations</Link>
      <div className="page-head">
        <div>
          <h1>{c.prompt}</h1>
          <p className="muted">{c.note}</p>
        </div>
        <div className="camp-detail-actions">
          {c.status === "ready" && (
            <button className="btn btn-ink" onClick={arm} disabled={busy}><Send /> Arm {ready} to send</button>
          )}
          <span className={`camp-pill ${c.status}`}>{c.status}</span>
        </div>
      </div>

      {(c.status === "scraping" || (c.status === "generating" && c.items.length === 0)) && (
        <div className="card camp-working"><Loader2 className="spin" /> {c.note}</div>
      )}

      {c.status === "armed" && (
        <div className="card camp-armed">
          <b>Armed to send.</b> Email delivery is the next phase — it needs your SMTP details in Settings. Once configured, the {ready} mockups drip out to each business with an unsubscribe link, and replies come back here as notifications.
        </div>
      )}

      {c.items.length > 0 && (
        <div className="camp-board">
          <div className="camp-board-head">
            <span>Business</span><span>Mockup</span><span>Contact</span><span></span>
          </div>
          {c.items.map((it) => {
            const Icon = MOCKUP_ICON[it.mockupStatus];
            return (
              <div className="camp-board-row card" key={it.prospectId}>
                <div className="camp-biz">
                  <div className="camp-biz-name">{it.business}</div>
                  <div className="muted camp-biz-url">{it.url.replace(/^https?:\/\//, "").replace(/\/.*/, "")}{it.scratch && " · no site (from Maps)"}</div>
                </div>
                <div className={`camp-mockup ${it.mockupStatus}`}>
                  <Icon className={it.mockupStatus === "generating" ? "spin" : ""} /> {MOCKUP_LABEL[it.mockupStatus]}
                </div>
                <div className="camp-contact muted">
                  {it.email || it.phone || "—"}
                </div>
                <div className="camp-actions">
                  {it.mockupLeadId && (it.mockupStatus === "ready" || it.mockupStatus === "review") && (
                    <Link to={`/leads/${it.mockupLeadId}`} className="btn btn-ghost btn-sm"><ExternalLink /> View mockup</Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
