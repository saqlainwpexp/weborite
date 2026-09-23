import { useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
import { ArrowRight, CalendarDays, X } from "lucide-react";
import type { SeoSite } from "../../../../shared/types";
import type { LayoutCtx } from "../../layout/Layout";
import { host, timeAgo } from "../../lib/api";
import { dayKey, parseDayKey } from "../../components/Calendar";

export function phaseState(s: SeoSite) {
  const running = Object.entries(s.runs).find(([, r]) => r?.status === "running");
  if (running) return { cls: "running", label: "Running" };
  if (!s.runs.qa) return { cls: "draft", label: "Not audited" };
  if (!s.qaSignedOff) return { cls: "needs_review", label: "QA in review" };
  if (!s.runs.fixes) return { cls: "running", label: "SEO phase" };
  return { cls: "ready", label: "Optimised" };
}

export function SitesTable({ items }: { items: SeoSite[] }) {
  const nav = useNavigate();
  if (!items.length) {
    return <div className="empty"><h4>No live sites yet</h4><p>Add a site once it's live to run post-launch QA, speed checks and on-page SEO.</p></div>;
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Site</th><th className="hide-sm">Pages</th><th>Phase</th><th className="hide-sm">Added</th><th aria-label="Open" /></tr></thead>
        <tbody>
          {items.map((s) => {
            const st = phaseState(s);
            return (
              <tr key={s.id} className="row" onClick={() => nav(`/seo/${s.id}`)}>
                <td><div className="lead-cell"><span className="biz-mark" aria-hidden="true">{s.name.slice(0, 1).toUpperCase()}</span><div style={{ minWidth: 0 }}><b>{s.name}</b><span>{host(s.siteUrl)}</span></div></div></td>
                <td className="hide-sm">{s.pages.length || "–"}</td>
                <td><span className={`status ${st.cls}`}><span className="dot" />{st.label}</span></td>
                <td className="hide-sm muted">{timeAgo(s.createdAt)}</td>
                <td style={{ textAlign: "right" }}><span className="btn btn-sm btn-icon btn-chip" aria-hidden="true"><ArrowRight /></span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function SeoList() {
  const { seoSites } = useOutletContext<LayoutCtx>();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const date = params.get("date");
  const shown = (seoSites ?? []).filter((s) => !date || dayKey(s.createdAt) === date);
  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span>Launch & SEO</span><span className="sep">/</span><span className="here">Live sites</span></nav>
      <div className="title-row">
        <h1 className="page-title">Live sites</h1>
        <div className="actions"><button className="btn btn-ink" onClick={() => nav("/seo/new")}>Add live site <ArrowRight /></button></div>
      </div>
      {date && (
        <div className="filter-row">
          <span className="filter-chip"><CalendarDays />Added {parseDayKey(date).toLocaleDateString("en-US", { month: "long", day: "numeric" })}
            <button type="button" aria-label="Clear date filter" onClick={() => setParams({})}><X /></button>
          </span>
        </div>
      )}
      <div className="card card-lg"><SitesTable items={shown} /></div>
    </>
  );
}
