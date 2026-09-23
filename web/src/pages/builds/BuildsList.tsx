import { useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
import { ArrowRight, CalendarDays, X } from "lucide-react";
import type { Build } from "../../../../shared/types";
import type { LayoutCtx } from "../../layout/Layout";
import { fileUrl, host, timeAgo } from "../../lib/api";
import { BuildStatusPill } from "../../components/builds";
import { dayKey, parseDayKey } from "../../components/Calendar";

export function BuildsTable({ builds }: { builds: Build[] }) {
  const nav = useNavigate();
  if (!builds.length) {
    return (
      <div className="empty">
        <h4>No builds yet</h4>
        <p>When a client approves a mockup, start a build to turn it into a full website.</p>
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Website</th>
            <th className="hide-sm">Pages</th>
            <th>Status</th>
            <th className="hide-sm">Started</th>
            <th aria-label="Open" />
          </tr>
        </thead>
        <tbody>
          {builds.map((b) => {
            const done = b.pages.filter((p) => p.status === "done").length;
            return (
              <tr key={b.id} className="row" onClick={() => nav(`/builds/${b.id}`)}>
                <td>
                  <div className="lead-cell">
                    <span className="thumb" style={{ backgroundImage: `url(${fileUrl(b.leadId, "mockup-desktop.jpg")})` }} />
                    <div style={{ minWidth: 0 }}><b>{b.business}</b><span>{host(b.url)}</span></div>
                  </div>
                </td>
                <td className="hide-sm nowrap">{done} / {b.pages.length}</td>
                <td><BuildStatusPill status={b.status} /></td>
                <td className="hide-sm muted">{timeAgo(b.createdAt)}</td>
                <td style={{ textAlign: "right" }}><span className="btn btn-sm btn-icon btn-chip" aria-hidden="true"><ArrowRight /></span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function BuildsList() {
  const { builds } = useOutletContext<LayoutCtx>();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const date = params.get("date");
  const shown = (builds ?? []).filter((b) => !date || dayKey(b.createdAt) === date);

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span>Builds</span><span className="sep">/</span><span className="here">All builds</span></nav>
      <div className="title-row">
        <h1 className="page-title">Builds</h1>
        <div className="actions"><button className="btn btn-ink" onClick={() => nav("/builds/new")}>New build <ArrowRight /></button></div>
      </div>
      {date && (
        <div className="filter-row">
          <span className="filter-chip"><CalendarDays />Started {parseDayKey(date).toLocaleDateString("en-US", { month: "long", day: "numeric" })}
            <button type="button" aria-label="Clear date filter" onClick={() => setParams({})}><X /></button>
          </span>
        </div>
      )}
      <div className="card card-lg"><BuildsTable builds={shown} /></div>
    </>
  );
}
