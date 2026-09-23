import { useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
import { ArrowRight, ShieldAlert, X } from "lucide-react";
import type { CareSite } from "../../../../shared/types";
import type { LayoutCtx } from "../../layout/Layout";
import { host, timeAgo } from "../../lib/api";

export type CareView = CareSite & { busy: boolean };

/** One status per site, most urgent first. */
export function careState(s: CareView) {
  if (s.busy || s.run?.status === "running") return { cls: "running", label: s.run?.status === "running" ? "Maintaining" : "Checking", key: "running" };
  if (s.run?.status === "waiting") return { cls: "needs_review", label: "Awaiting approval", key: "approve" };
  if (s.run?.status === "failed") return { cls: "failed", label: "Stopped", key: "stopped" };
  if (!s.connected?.ok) return { cls: "draft", label: s.connected ? "Not connected" : "Not scanned", key: "offline" };
  if (s.summary?.critical) return { cls: "failed", label: "Vulnerable", key: "vulnerable" };
  if (s.summary?.updates) return { cls: "queued", label: "Updates due", key: "updates" };
  return { cls: "ready", label: "Healthy", key: "healthy" };
}

export const lastMaintained = (s: CareSite) => s.history[0]?.finishedAt;

export function CareTable({ items, compact }: { items: CareView[]; compact?: boolean }) {
  const nav = useNavigate();
  if (!items.length) {
    return <div className="empty"><h4>No sites in maintenance yet</h4><p>Add a client site, install the Studio Connector on it, and the monthly checks start from there.</p></div>;
  }
  return (
    <div className="table-wrap">
      <table className="table care-table">
        <thead>
          <tr>
            <th>Site</th>
            <th className="hide-sm">WordPress</th>
            <th className="hide-sm">PHP</th>
            <th>Updates</th>
            {!compact && <th className="hide-sm">Security</th>}
            <th>Status</th>
            {!compact && <th className="hide-sm">Maintained</th>}
            <th aria-label="Open" />
          </tr>
        </thead>
        <tbody>
          {items.map((s) => {
            const st = careState(s);
            const sum = s.summary;
            return (
              <tr key={s.id} className="row" onClick={() => nav(`/care/${s.id}`)}>
                <td><div className="lead-cell"><span className="biz-mark" aria-hidden="true">{s.name.slice(0, 1).toUpperCase()}</span><div style={{ minWidth: 0 }}><b>{s.name}</b><span>{s.client ? `${s.client} · ` : ""}{host(s.siteUrl)}</span></div></div></td>
                <td className="hide-sm">{sum?.wp ?? "–"}</td>
                <td className="hide-sm">{sum?.php ?? "–"}</td>
                <td>{sum ? <span className={`pill-num ${sum.security ? "bad" : sum.updates ? "ok" : "good"}`}>{sum.updates}</span> : "–"}</td>
                {!compact && <td className="hide-sm">{sum ? (sum.vulns ? <span className="sec-cell bad"><ShieldAlert />{sum.vulns} known</span> : <span className="good">No known issues</span>) : "–"}</td>}
                <td><span className={`status ${st.cls}`}><span className="dot" />{st.label}</span></td>
                {!compact && <td className="hide-sm muted">{lastMaintained(s) ? timeAgo(lastMaintained(s)) : "Never"}</td>}
                <td style={{ textAlign: "right" }}><span className="btn btn-sm btn-icon btn-chip" aria-hidden="true"><ArrowRight /></span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const FILTERS = [
  ["all", "All"],
  ["approve", "Awaiting approval"],
  ["updates", "Updates due"],
  ["vulnerable", "Vulnerable"],
  ["stopped", "Stopped"],
  ["offline", "Not connected"],
  ["healthy", "Healthy"],
] as const;

export default function CareList() {
  const { careSites } = useOutletContext<LayoutCtx>();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const filter = params.get("show") ?? "all";
  const all = careSites ?? [];
  const shown = all.filter((s) => filter === "all" || careState(s).key === filter);
  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span>Maintenance</span><span className="sep">/</span><span className="here">Sites</span></nav>
      <div className="title-row">
        <h1 className="page-title">Sites</h1>
        <div className="actions"><button className="btn btn-ink" onClick={() => nav("/care/new")}>Add site <ArrowRight /></button></div>
      </div>
      <div className="filter-row">
        {FILTERS.map(([k, l]) => {
          const n = k === "all" ? all.length : all.filter((s) => careState(s).key === k).length;
          if (k !== "all" && !n && filter !== k) return null;
          return (
            <button key={k} type="button" className={`chip chip-btn${filter === k ? " on" : ""}`} onClick={() => setParams(k === "all" ? {} : { show: k })}>
              {l} <span className="muted">{n}</span>{filter === k && k !== "all" && <X size={14} />}
            </button>
          );
        })}
      </div>
      <div className="card card-lg"><CareTable items={shown} /></div>
    </>
  );
}
