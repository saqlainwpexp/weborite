import { useNavigate, useOutletContext } from "react-router-dom";
import { ArrowRight, ArrowUpRight, ClipboardCheck, Gauge, ListChecks, Search } from "lucide-react";
import type { LayoutCtx } from "../../layout/Layout";
import { host } from "../../lib/api";
import { SitesTable } from "./SeoList";

const PHASES = [
  { n: 1, title: "Post-launch QA", text: "Test every form, proofread every page, and catch a wrong phone number, email or address anywhere on the site." },
  { n: 2, title: "Performance", text: "Page speed, Core Web Vitals (lab and real users), page experience, page size and GTmetrix." },
  { n: 3, title: "On-page SEO", text: "Alt text, WebP compression, meta titles and descriptions, and schema for every page. Applied straight to WordPress." },
  { n: 4, title: "Checklist", text: "Every automated check plus your own custom items, ticked off per site." },
];

export default function SeoDashboard() {
  const { seoSites, conversions } = useOutletContext<LayoutCtx>();
  const nav = useNavigate();
  const all = seoSites ?? [];
  const delivered = (conversions ?? []).filter((c) => c.status === "done" && !all.some((s) => s.conversionId === c.id));
  const stats = [
    { label: "Live sites", value: all.length, icon: <Gauge /> },
    { label: "In QA review", value: all.filter((s) => s.runs.qa && !s.qaSignedOff).length, icon: <ClipboardCheck /> },
    { label: "QA signed off", value: all.filter((s) => s.qaSignedOff).length, icon: <ListChecks /> },
    { label: "SEO fixes applied", value: all.filter((s) => s.runs.fixes?.status === "done").length, icon: <Search /> },
  ];
  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span>Launch & SEO</span><span className="sep">/</span><span className="here">Dashboard</span></nav>
      <div className="title-row">
        <h1 className="page-title">Post launch & on-page SEO</h1>
        <div className="actions">
          <button className="btn btn-white" onClick={() => nav("/seo/checklist")}>Checklist template</button>
          <button className="btn btn-ink" onClick={() => nav("/seo/new")}>Audit a live site <ArrowRight /></button>
        </div>
      </div>
      <div className="grid-main">
        <div className="stack">
          <div className="four">
            {stats.map((s) => (
              <div key={s.label} className="card stat">
                <div className="top"><span className="tile">{s.icon}</span></div>
                <div><b>{seoSites ? s.value : "–"}</b><span style={{ display: "block", marginTop: 8 }}>{s.label}</span></div>
              </div>
            ))}
          </div>
          <div className="card card-lg">
            <div className="card-head" style={{ marginBottom: 20 }}>
              <div><h3 className="card-title">Live sites</h3><p className="card-sub">Each site moves through QA, performance and on-page SEO</p></div>
              <button className="btn btn-chip btn-sm" onClick={() => nav("/seo/all")}>View all</button>
            </div>
            <SitesTable items={all.slice(0, 8)} />
          </div>
        </div>
        <div className="stack side-col">
          {delivered.length > 0 && (
            <div className="card">
              <h3 className="card-title">Just launched <ArrowUpRight size={22} strokeWidth={1.6} /></h3>
              <p className="card-sub">Finished WordPress conversions without an audit</p>
              <div className="search-list">
                {delivered.slice(0, 5).map((c) => (
                  <button key={c.id} type="button" className="search-row" style={{ gridTemplateColumns: "12px minmax(0,1fr) auto" }} onClick={() => nav(`/seo/new?conversion=${c.id}`)}>
                    <span className="sq" style={{ background: "var(--green)" }} />
                    <span className="search-main"><b>{c.business}</b><small>{host(c.siteUrl)}</small></span>
                    <span className="btn btn-chip btn-xs">Audit</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="card">
            <h3 className="card-title">The four phases</h3>
            <div className="phase-list">
              {PHASES.map((p) => (
                <div key={p.n} className="phase-item"><span className="page-num">{p.n}</span><div><b>{p.title}</b><p>{p.text}</p></div></div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
