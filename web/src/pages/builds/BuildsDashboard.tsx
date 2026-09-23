import { useNavigate, useOutletContext } from "react-router-dom";
import { ArrowRight, ArrowUpRight, Blocks, CheckCircle2, FileStack, Loader2 } from "lucide-react";
import type { LayoutCtx } from "../../layout/Layout";
import { fileUrl, host, timeAgo } from "../../lib/api";
import { BuildStatusPill } from "../../components/builds";
import { BuildsTable } from "./BuildsList";

export default function BuildsDashboard() {
  const { builds, buildStats: st, leads } = useOutletContext<LayoutCtx>();
  const nav = useNavigate();

  // Finished mockups that don't have a build yet.
  const waiting = (leads ?? []).filter((l) => l.steps.find((s) => s.key === "generate")?.status === "done" && !(builds ?? []).some((b) => b.leadId === l.id));

  const stats = [
    { label: "Builds", value: st?.total, icon: <Blocks /> },
    { label: "In progress", value: st?.running, icon: <Loader2 /> },
    { label: "Ready to hand over", value: st?.ready, icon: <CheckCircle2 /> },
    { label: "Pages written", value: st?.pages, icon: <FileStack /> },
  ];

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span>Builds</span><span className="sep">/</span><span className="here">Dashboard</span></nav>
      <div className="title-row">
        <h1 className="page-title">Overview</h1>
        <div className="actions">
          <button className="btn btn-white" onClick={() => nav("/builds/all")}>All builds</button>
          <button className="btn btn-ink" onClick={() => nav("/builds/new")}>New build <ArrowRight /></button>
        </div>
      </div>

      <div className="grid-main">
        <div className="stack">
          <div className="four">
            {stats.map((s) => (
              <div key={s.label} className="card stat">
                <div className="top"><span className="tile">{s.icon}</span></div>
                <div>
                  <b>{st ? s.value : "–"}</b>
                  <span style={{ display: "block", marginTop: 8 }}>{s.label}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="card card-lg">
            <div className="card-head" style={{ marginBottom: 20 }}>
              <div>
                <h3 className="card-title">Recent builds</h3>
                <p className="card-sub">Full websites made from approved mockups</p>
              </div>
              <button className="btn btn-chip btn-sm" onClick={() => nav("/builds/all")}>View all</button>
            </div>
            <BuildsTable builds={(builds ?? []).slice(0, 8)} />
          </div>
        </div>

        <div className="stack side-col">
          <div className="card">
            <h3 className="card-title">Ready to build <ArrowUpRight size={22} strokeWidth={1.6} /></h3>
            <p className="card-sub">Finished mockups without a website build yet</p>
            <div className="search-list">
              {waiting.slice(0, 5).map((l) => (
                <button key={l.id} type="button" className="search-row" style={{ gridTemplateColumns: "56px minmax(0,1fr) auto" }} onClick={() => nav(`/builds/new?lead=${l.id}`)}>
                  <span className="thumb" style={{ width: 56, backgroundImage: `url(${fileUrl(l.id, "mockup-desktop.jpg")})` }} />
                  <span className="search-main"><b>{l.business || host(l.url)}</b><small>{host(l.url)} · mockup {timeAgo(l.steps.find((s) => s.key === "render")?.finishedAt ?? l.createdAt)}</small></span>
                  <span className="btn btn-chip btn-xs">Start</span>
                </button>
              ))}
              {!waiting.length && <p className="side-empty" style={{ padding: "8px 0" }}>Every finished mockup already has a build.</p>}
            </div>
          </div>

          <div className="card">
            <h3 className="card-title">How a build runs</h3>
            <dl className="fields">
              <div className="field"><dt>1. Homepage</dt><dd>Your change requests are applied to the approved mockup.</dd></div>
              <div className="field"><dt>2. Layout</dt><dd>Header, footer and styles become shared, so every page matches.</dd></div>
              <div className="field"><dt>3. Pages</dt><dd>Claude writes each page from your brief and the project details.</dd></div>
              <div className="field"><dt>4. Checks</dt><dd>Contrast, facts, mobile and links on every page, with one automatic fix.</dd></div>
            </dl>
            {builds?.[0] && <div style={{ marginTop: 14 }}><BuildStatusPill status={builds[0].status} /></div>}
          </div>
        </div>
      </div>
    </>
  );
}
