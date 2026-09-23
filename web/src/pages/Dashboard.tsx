import { useNavigate, useOutletContext } from "react-router-dom";
import { AlertTriangle, ArrowRight, ArrowUpRight, CheckCircle2, Loader2, StickyNote, Users } from "lucide-react";
import type { LayoutCtx } from "../layout/Layout";
import { LeadsTable } from "../components/LeadsTable";
import { EventIcon } from "../components/ui";
import { timeAgo } from "../lib/api";

export default function Dashboard() {
  const { leads, events, benchmarks, openAdd } = useOutletContext<LayoutCtx>();
  const nav = useNavigate();
  const all = leads ?? [];
  const count = (f: (s: string) => boolean) => all.filter((l) => f(l.status)).length;

  const stats = [
    { label: "Total leads", value: all.length, icon: <Users /> },
    { label: "Mockups ready", value: count((s) => s === "ready"), icon: <CheckCircle2 /> },
    { label: "In progress", value: count((s) => s === "running" || s === "queued" || s === "paused"), icon: <Loader2 /> },
    { label: "Needs review", value: count((s) => s === "needs_review" || s === "failed"), icon: <AlertTriangle /> },
  ];

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span className="here">Dashboard</span></nav>
      <div className="title-row">
        <h1 className="page-title">Overview</h1>
        <div className="actions">
          <button className="btn btn-white" onClick={() => nav("/leads")}>All leads</button>
          <button className="btn btn-ink" onClick={openAdd}>New mockup <ArrowRight /></button>
        </div>
      </div>

      <div className="grid-main">
        <div className="stack">
          <div className="four">
            {stats.map((s) => (
              <div key={s.label} className="card stat">
                <div className="top"><span className="tile">{s.icon}</span></div>
                <div>
                  <b>{leads ? s.value : "–"}</b>
                  <span style={{ display: "block", marginTop: 8 }}>{s.label}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="card card-lg">
            <div className="card-head" style={{ marginBottom: 20 }}>
              <div>
                <h3 className="card-title">Recent leads</h3>
                <p className="card-sub">The latest submissions and where each mockup is</p>
              </div>
              <button className="btn btn-chip btn-sm" onClick={() => nav("/leads")}>View all</button>
            </div>
            <LeadsTable compact leads={all.slice(0, 8)} benchmarks={benchmarks ?? []} />
          </div>
        </div>

        <div className="stack side-col">
          <div className="card">
            <div className="notif-list">
              {(events ?? []).slice(0, 5).map((e, i) => (
                <button key={e.id} className={`notif${i === 0 ? " hl" : ""}`} style={{ border: 0, textAlign: "left", background: undefined }} onClick={() => e.leadId && nav(`/leads/${e.leadId}`)}>
                  <span className="tile"><EventIcon kind={e.kind} /></span>
                  <div><b>{e.title}</b><span>{e.detail} · {timeAgo(e.at)}</span></div>
                  <ArrowUpRight />
                </button>
              ))}
              {!events?.length && <p className="side-empty" style={{ padding: 10 }}>New leads and finished mockups show up here.</p>}
            </div>
            <div className="notif-foot">
              <button className="btn btn-ink btn-sm" onClick={() => nav("/leads")}>See all leads <ArrowRight /></button>
              <button className="link-btn" onClick={() => nav("/benchmarks")}><StickyNote />Benchmarks</button>
            </div>
          </div>

          <div className="card">
            <h3 className="card-title">Verticals <ArrowUpRight size={22} strokeWidth={1.6} /></h3>
            <p className="card-sub">Benchmark sets reused for every lead in the category</p>
            <div className="steps">
              {(benchmarks ?? []).map((b) => (
                <button key={b.vertical} className="step" style={{ textAlign: "left", background: "none" }} onClick={() => nav(`/leads?vertical=${b.vertical}`)}>
                  <div><b>{b.label}</b><span>{b.sites.length} sites · {b.leadCount} leads</span></div>
                  <span className="vchip"><i style={{ background: b.color, width: 14, height: 14 }} /></span>
                </button>
              ))}
              {!benchmarks?.length && <p className="side-empty">None yet. The first lead in each vertical builds its set.</p>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
