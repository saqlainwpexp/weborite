import { useOutletContext, useSearchParams } from "react-router-dom";
import { CalendarDays, Search, X } from "lucide-react";
import type { BidProject } from "../../../../shared/types";
import type { LayoutCtx } from "../../layout/Layout";
import { dayKey, parseDayKey } from "../../components/Calendar";
import { BidProjectsTable } from "../../components/bidder";

const FILTERS: { key: string; label: string; match: (p: BidProject) => boolean }[] = [
  { key: "all", label: "All", match: (p) => p.status !== "skipped" },
  { key: "ready", label: "To review", match: (p) => p.status === "ready" },
  { key: "bid", label: "Bid placed", match: (p) => p.status === "bid" },
  { key: "working", label: "In progress", match: (p) => p.status === "new" || p.status === "drafting" || p.status === "bidding" },
  { key: "failed", label: "Failed", match: (p) => p.status === "failed" },
  { key: "skipped", label: "Skipped", match: (p) => p.status === "skipped" },
];

export default function BidderProjects() {
  const { bidProjects } = useOutletContext<LayoutCtx>();
  const [params, setParams] = useSearchParams();
  const show = params.get("show") ?? "all";
  const q = params.get("q") ?? "";
  const date = params.get("date");
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const filter = FILTERS.find((f) => f.key === show) ?? FILTERS[0];
  const needle = q.trim().toLowerCase();
  const shown = (bidProjects ?? []).filter(
    (p) => filter.match(p) && (!date || dayKey(p.foundAt) === date) && (!needle || `${p.title} ${p.skills.join(" ")} ${p.client.country}`.toLowerCase().includes(needle)),
  );

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span>Freelancer Bids</span><span className="sep">/</span><span className="here">Projects</span></nav>
      <div className="title-row"><h1 className="page-title">Projects</h1></div>

      <div className="filter-bar">
        <div className="seg" role="tablist" aria-label="Filter by status">
          {FILTERS.map((f) => (
            <button key={f.key} role="tab" aria-selected={show === f.key} className={show === f.key ? "on" : ""} onClick={() => set("show", f.key === "all" ? null : f.key)}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="input-icon filter-search">
          <Search />
          <input className="input" placeholder="Filter by title, skill, country…" value={q} onChange={(e) => set("q", e.target.value || null)} aria-label="Filter projects" />
        </div>
        {date && (
          <span className="filter-chip">
            <CalendarDays />Found {parseDayKey(date).toLocaleDateString("en-US", { month: "long", day: "numeric" })}
            <button type="button" aria-label="Clear date filter" onClick={() => set("date", null)}><X /></button>
          </span>
        )}
        <span className="muted" style={{ marginLeft: "auto" }}>{shown.length} project{shown.length === 1 ? "" : "s"}</span>
      </div>

      <div className="card card-lg">
        <BidProjectsTable projects={shown} empty={show === "skipped" ? "Projects your filters or Claude passed on show up here, with the reason." : undefined} />
      </div>
    </>
  );
}
