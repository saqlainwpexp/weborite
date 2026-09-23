import { useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
import { ArrowRight, CalendarDays, X } from "lucide-react";
import type { WpConversion, WpPageStatus, WpStatus } from "../../../../shared/types";
import type { LayoutCtx } from "../../layout/Layout";
import { host, timeAgo } from "../../lib/api";
import { dayKey, parseDayKey } from "../../components/Calendar";

const STATUS: Record<WpStatus, [string, string]> = {
  setup: ["draft", "Setup"],
  running: ["running", "Converting"],
  paused: ["paused", "Waiting on you"],
  awaiting_approval: ["needs_review", "Awaiting approval"],
  done: ["ready", "Delivered"],
  failed: ["failed", "Failed"],
};

export function WpStatusPill({ status }: { status: WpStatus }) {
  const [cls, label] = STATUS[status];
  return <span className={`status ${cls}`}><span className="dot" />{label}</span>;
}

const PAGE: Record<WpPageStatus, [string, string]> = {
  pending: ["draft", "Waiting"],
  converting: ["running", "Converting"],
  awaiting_approval: ["needs_review", "Needs your approval"],
  approved: ["ready", "Approved"],
  changes_requested: ["running", "Revising"],
  failed: ["failed", "Failed"],
};

export function WpPagePill({ status }: { status: WpPageStatus }) {
  const [cls, label] = PAGE[status];
  return <span className={`status ${cls}`}><span className="dot" />{label}</span>;
}

export function ConversionsTable({ items }: { items: WpConversion[] }) {
  const nav = useNavigate();
  if (!items.length) {
    return (
      <div className="empty">
        <h4>No conversions yet</h4>
        <p>Open a finished build and choose “Convert to WordPress”.</p>
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>Website</th><th className="hide-sm">Elementor</th><th>Pages</th><th>Status</th><th className="hide-sm">Started</th><th aria-label="Open" /></tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id} className="row" onClick={() => nav(`/wp/${c.id}`)}>
              <td>
                <div className="lead-cell">
                  <span className="biz-mark" aria-hidden="true">{c.business.slice(0, 1).toUpperCase()}</span>
                  <div style={{ minWidth: 0 }}><b>{c.business}</b><span>{host(c.siteUrl)}</span></div>
                </div>
              </td>
              <td className="hide-sm"><span className="chip">{c.elementorPro ? "Pro" : "Free + custom widgets"}</span></td>
              <td className="nowrap">{c.pages.filter((p) => p.status === "approved").length} / {c.pages.length} approved</td>
              <td><WpStatusPill status={c.status} /></td>
              <td className="hide-sm muted">{timeAgo(c.createdAt)}</td>
              <td style={{ textAlign: "right" }}><span className="btn btn-sm btn-icon btn-chip" aria-hidden="true"><ArrowRight /></span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function WpList() {
  const { conversions } = useOutletContext<LayoutCtx>();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const date = params.get("date");
  const shown = (conversions ?? []).filter((c) => !date || dayKey(c.createdAt) === date);
  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span>WordPress</span><span className="sep">/</span><span className="here">Conversions</span></nav>
      <div className="title-row">
        <h1 className="page-title">Conversions</h1>
        <div className="actions"><button className="btn btn-ink" onClick={() => nav("/wp/new")}>New conversion <ArrowRight /></button></div>
      </div>
      {date && (
        <div className="filter-row">
          <span className="filter-chip"><CalendarDays />Started {parseDayKey(date).toLocaleDateString("en-US", { month: "long", day: "numeric" })}
            <button type="button" aria-label="Clear date filter" onClick={() => setParams({})}><X /></button>
          </span>
        </div>
      )}
      <div className="card card-lg"><ConversionsTable items={shown} /></div>
    </>
  );
}
