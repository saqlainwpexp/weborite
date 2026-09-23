import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { ListChecks, Plus, Trash2 } from "lucide-react";
import type { LayoutCtx } from "../../layout/Layout";
import { api } from "../../lib/api";

const AUTO_GROUPS = [
  ["Post-launch QA", "Forms submit, no spelling mistakes, consistent contact details, no broken links"],
  ["Performance", "LCP, CLS, TBT, mobile score, page weight"],
  ["Page experience", "HTTPS, mobile-friendly, no console errors"],
  ["On-page SEO", "Titles, descriptions, H1, alt text, WebP, image weight, schema, canonical, noindex, Open Graph, language"],
  ["Technical", "Sitemap, robots.txt, HTTPS redirect, real 404, favicon"],
];

export default function SeoChecklistTemplate() {
  const { settings, reloadAll } = useOutletContext<LayoutCtx>();
  const [items, setItems] = useState<{ label: string; group: string }[]>([]);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (settings) setItems(settings.seoChecklist);
  }, [settings]);

  async function save(next = items) {
    await api("/api/settings", { method: "PUT", json: { seoChecklist: next } });
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
    reloadAll();
  }

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span>Launch & SEO</span><span className="sep">/</span><span className="here">Checklist</span></nav>
      <div className="title-row"><h1 className="page-title">Checklist template</h1></div>
      <p className="muted" style={{ maxWidth: 640, marginTop: -8 }}>Automated checks run on every site. Add your own items below; they appear on every site's checklist to tick off by hand.</p>
      <div className="set-stack">
        <section className="set-section">
          <h3 className="set-title"><ListChecks />Your custom items</h3>
          <div className="set-body">
            {items.map((it, i) => (
              <div key={i} className="page-row">
                <span className="page-num">{i + 1}</span>
                <div className="page-fields">
                  <input className="input" aria-label="Group" value={it.group} onChange={(e) => setItems(items.map((x, n) => (n === i ? { ...x, group: e.target.value } : x)))} placeholder="Group" />
                  <input className="input" aria-label="Checklist item" value={it.label} onChange={(e) => setItems(items.map((x, n) => (n === i ? { ...x, label: e.target.value } : x)))} placeholder="e.g. Google Business Profile links to the site" />
                </div>
                <div className="page-tools"><button type="button" className="icon-btn sm" aria-label="Remove item" onClick={() => setItems(items.filter((_, n) => n !== i))}><Trash2 /></button></div>
              </div>
            ))}
            {!items.length && <div className="set-card muted">No custom items yet.</div>}
            <div className="preset-chips">
              <button type="button" className="chip chip-btn" onClick={() => setItems([...items, { label: "", group: "Custom" }])}><Plus />Add item</button>
              {["Google Search Console verified", "Google Analytics / Tag Manager installed", "Google Business Profile links to the site", "Cookie banner works and blocks tracking until consent", "Privacy policy and terms pages linked in the footer", "Backups scheduled"].filter((l) => !items.some((x) => x.label === l)).slice(0, 4).map((l) => (
                <button key={l} type="button" className="chip chip-btn" onClick={() => setItems([...items, { label: l, group: "Launch" }])}><Plus />{l}</button>
              ))}
            </div>
          </div>
        </section>
        <section className="set-section">
          <h3 className="set-title"><ListChecks />Automated checks (always included)</h3>
          <div className="set-body">
            <dl className="fields" style={{ marginTop: 0 }}>
              {AUTO_GROUPS.map(([g, d]) => <div key={g} className="field"><dt>{g}</dt><dd>{d}</dd></div>)}
            </dl>
          </div>
        </section>
      </div>
      <div className="set-actions">
        <button className="btn btn-ink" onClick={() => save()}>Save checklist</button>
        {saved && <span className="status ready"><span className="dot" />Saved</span>}
      </div>
    </>
  );
}
