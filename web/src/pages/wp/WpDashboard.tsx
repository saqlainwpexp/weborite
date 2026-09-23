import { useNavigate, useOutletContext } from "react-router-dom";
import { ArrowRight, ArrowUpRight, CheckCircle2, FileCheck2, Hourglass, PanelsTopLeft } from "lucide-react";
import type { LayoutCtx } from "../../layout/Layout";
import { fileUrl, host } from "../../lib/api";
import { ConversionsTable } from "./WpList";

export default function WpDashboard() {
  const { conversions, builds } = useOutletContext<LayoutCtx>();
  const nav = useNavigate();
  const all = conversions ?? [];
  const awaiting = all.flatMap((c) => c.pages.filter((p) => p.status === "awaiting_approval").map((p) => ({ c, p })));
  const readyBuilds = (builds ?? []).filter((b) => (b.status === "ready" || b.status === "needs_review") && !all.some((c) => c.buildId === b.id));

  const stats = [
    { label: "Conversions", value: all.length, icon: <PanelsTopLeft /> },
    { label: "Waiting for approval", value: awaiting.length, icon: <Hourglass /> },
    { label: "Pages approved", value: all.reduce((n, c) => n + c.pages.filter((p) => p.status === "approved").length, 0), icon: <FileCheck2 /> },
    { label: "Sites delivered", value: all.filter((c) => c.status === "done").length, icon: <CheckCircle2 /> },
  ];

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span>WordPress</span><span className="sep">/</span><span className="here">Dashboard</span></nav>
      <div className="title-row">
        <h1 className="page-title">Overview</h1>
        <div className="actions">
          <button className="btn btn-white" onClick={() => nav("/wp/all")}>All conversions</button>
          <button className="btn btn-ink" onClick={() => nav("/wp/new")}>Convert a build <ArrowRight /></button>
        </div>
      </div>

      <div className="grid-main">
        <div className="stack">
          <div className="four">
            {stats.map((s) => (
              <div key={s.label} className="card stat">
                <div className="top"><span className="tile">{s.icon}</span></div>
                <div><b>{conversions ? s.value : "–"}</b><span style={{ display: "block", marginTop: 8 }}>{s.label}</span></div>
              </div>
            ))}
          </div>

          {awaiting.length > 0 && (
            <div className="card card-lg">
              <h3 className="card-title">Needs your approval</h3>
              <p className="card-sub">Each page waits here before the next one starts</p>
              <div className="search-list">
                {awaiting.map(({ c, p }) => (
                  <button key={c.id + p.slug} type="button" className="search-row" style={{ gridTemplateColumns: "12px minmax(0,1fr) auto" }} onClick={() => nav(`/wp/${c.id}?page=${p.slug}`)}>
                    <span className="sq" style={{ background: "var(--orange)" }} />
                    <span className="search-main"><b>{c.business}: {p.title}</b><small>{p.diff ? `${p.diff.desktop}% desktop / ${p.diff.mobile}% mobile pixels differ` : "Ready to review"}</small></span>
                    <span className="btn btn-ink btn-xs">Review</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="card card-lg">
            <div className="card-head" style={{ marginBottom: 20 }}>
              <div><h3 className="card-title">Conversions</h3><p className="card-sub">Builds turned into Elementor pages, one approved page at a time</p></div>
              <button className="btn btn-chip btn-sm" onClick={() => nav("/wp/all")}>View all</button>
            </div>
            <ConversionsTable items={all.slice(0, 8)} />
          </div>
        </div>

        <div className="stack side-col">
          <div className="card">
            <h3 className="card-title">Ready to convert <ArrowUpRight size={22} strokeWidth={1.6} /></h3>
            <p className="card-sub">Finished builds without a WordPress version</p>
            <div className="search-list">
              {readyBuilds.slice(0, 5).map((b) => (
                <button key={b.id} type="button" className="search-row" style={{ gridTemplateColumns: "56px minmax(0,1fr) auto" }} onClick={() => nav(`/wp/new?build=${b.id}`)}>
                  <span className="thumb" style={{ width: 56, backgroundImage: `url(${fileUrl(b.leadId, "mockup-desktop.jpg")})` }} />
                  <span className="search-main"><b>{b.business}</b><small>{host(b.url)} · {b.pages.length} pages</small></span>
                  <span className="btn btn-chip btn-xs">Convert</span>
                </button>
              ))}
              {!readyBuilds.length && <p className="side-empty" style={{ padding: "8px 0" }}>Every finished build already has a conversion.</p>}
            </div>
          </div>
          <div className="card">
            <h3 className="card-title">The rules</h3>
            <dl className="fields">
              <div className="field"><dt>Widgets</dt><dd>Native Elementor containers and widgets only. No HTML or Shortcode widgets, ever.</dd></div>
              <div className="field"><dt>With Pro</dt><dd>Pro widgets (Form, Nav Menu, Slides…) and theme-builder header/footer.</dd></div>
              <div className="field"><dt>Without Pro</dt><dd>Anything that needs Pro becomes a custom Elementor widget inside the connector plugin.</dd></div>
              <div className="field"><dt>Approval</dt><dd>One page at a time. The next page starts when you approve.</dd></div>
            </dl>
          </div>
        </div>
      </div>
    </>
  );
}
