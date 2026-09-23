import { useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { ArrowRight, Building2, Gauge, Globe, KeyRound, Plug, User, UserRound, XCircle } from "lucide-react";
import type { CareSite, SeoSite } from "../../../../shared/types";
import type { LayoutCtx } from "../../layout/Layout";
import { api, host, usePoll } from "../../lib/api";
import { Dropdown } from "../../components/Dropdown";

export default function CareNew() {
  const nav = useNavigate();
  const { reloadAll, careSites } = useOutletContext<LayoutCtx>();
  const { data: seoSites } = usePoll<SeoSite[]>("/api/seo", 30000);
  const [fromSeo, setFromSeo] = useState("");
  // Launch & SEO sites with a saved login that aren't in maintenance yet.
  const reusable = (seoSites ?? []).filter((x) => (x.conversionId || x.appPasswordSet) && !(careSites ?? []).some((c) => c.siteUrl === x.siteUrl));
  const [form, setForm] = useState({ name: "", client: "", siteUrl: "", wpUser: "", appPassword: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api<CareSite>("/api/care", { method: "POST", json: fromSeo ? { fromSeo, name: form.name, client: form.client } : form });
      reloadAll();
      nav(`/care/${s.id}?welcome=1`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/care/all">Maintenance</Link><span className="sep">/</span><span className="here">Add site</span></nav>
      <div className="title-row"><h1 className="page-title">Add a site to maintenance</h1></div>
      <form className="set-stack" onSubmit={submit}>
        {reusable.length > 0 && (
          <section className="set-section">
            <h3 className="set-title"><Gauge />From a site you already connected</h3>
            <div className="set-body">
              <div className="set-grid">
                <div className="set-field">
                  <label htmlFor="c-from">Launch & SEO site</label>
                  <Dropdown field id="c-from" label="Launch & SEO site" icon={<Gauge />} value={fromSeo} onChange={setFromSeo}
                    options={[{ value: "", label: "None: enter a site below" }, ...reusable.map((x) => ({ value: x.id, label: x.name, hint: host(x.siteUrl) }))]} />
                  <span className="hint">Reuses its saved WordPress login. The account must be an administrator for updates.</span>
                </div>
                <div className="set-field"><label htmlFor="c-client0">Client (optional)</label><div className="input-icon"><UserRound /><input id="c-client0" className="input" value={form.client} onChange={set("client")} placeholder="Who the monthly report is for" /></div></div>
              </div>
            </div>
          </section>
        )}
        {!fromSeo && <>
        <section className="set-section">
          <h3 className="set-title"><Globe />Site</h3>
          <div className="set-body">
            <div className="set-grid">
              <div className="set-field"><label htmlFor="c-url">Live URL</label><div className="input-icon"><Globe /><input id="c-url" className="input" value={form.siteUrl} onChange={set("siteUrl")} placeholder="https://client-site.com" required /></div></div>
              <div className="set-field"><label htmlFor="c-name">Site name</label><div className="input-icon"><Building2 /><input id="c-name" className="input" value={form.name} onChange={set("name")} placeholder="Shown in the dashboard and reports" /></div></div>
              <div className="set-field"><label htmlFor="c-client">Client (optional)</label><div className="input-icon"><UserRound /><input id="c-client" className="input" value={form.client} onChange={set("client")} placeholder="Who the monthly report is for" /></div></div>
            </div>
          </div>
        </section>
        <section className="set-section">
          <h3 className="set-title"><KeyRound />WordPress access</h3>
          <div className="set-body">
            <div className="set-grid">
              <div className="set-field"><label htmlFor="c-user">Administrator username</label><div className="input-icon"><User /><input id="c-user" className="input" value={form.wpUser} onChange={set("wpUser")} autoComplete="off" required /></div></div>
              <div className="set-field"><label htmlFor="c-pass">Application Password</label><div className="input-icon"><KeyRound /><input id="c-pass" className="input mono" type="password" value={form.appPassword} onChange={set("appPassword")} autoComplete="off" required /></div>
                <span className="hint">In WordPress: Users → Profile → Application Passwords. Updates need an administrator account. It stays on this PC.</span></div>
            </div>
            <div className="set-card" style={{ marginTop: 16 }}>
              <b style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 500 }}><Plug size={16} />Next: install the Studio Connector</b>
              <p className="muted" style={{ marginTop: 6, fontSize: 14 }}>After adding the site you'll get the plugin zip. Upload it under Plugins → Add New → Upload Plugin and activate it. If the site already runs the connector from a conversion or SEO audit, update it to the new version: maintenance needs it.</p>
            </div>
          </div>
        </section>
        </>}
        {error && <div className="banner err"><XCircle />{error}</div>}
        <div className="set-actions"><button className="btn btn-ink" disabled={busy || (!fromSeo && (!form.siteUrl || !form.wpUser || !form.appPassword))}>{busy ? "Adding…" : "Add site"} <ArrowRight /></button></div>
      </form>
    </>
  );
}
