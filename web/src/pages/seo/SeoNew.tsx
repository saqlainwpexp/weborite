import { useState } from "react";
import { Link, useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
import { ArrowRight, Building2, Globe, KeyRound, PanelsTopLeft, User, XCircle } from "lucide-react";
import type { SeoSite } from "../../../../shared/types";
import type { LayoutCtx } from "../../layout/Layout";
import { api, host } from "../../lib/api";
import { Dropdown } from "../../components/Dropdown";

export default function SeoNew() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { conversions, reloadAll } = useOutletContext<LayoutCtx>();
  const [conversionId, setConversionId] = useState(params.get("conversion") ?? "");
  const [form, setForm] = useState({ name: "", siteUrl: "", wpUser: "", appPassword: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const conv = (conversions ?? []).find((c) => c.id === conversionId);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api<SeoSite>("/api/seo", { method: "POST", json: conv ? { conversionId } : form });
      reloadAll();
      nav(`/seo/${s.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/seo/all">Launch & SEO</Link><span className="sep">/</span><span className="here">Add live site</span></nav>
      <div className="title-row"><h1 className="page-title">Audit a live site</h1></div>
      <form className="set-stack" onSubmit={submit}>
        <section className="set-section">
          <h3 className="set-title"><PanelsTopLeft />From a WordPress conversion</h3>
          <div className="set-body">
            <div className="set-grid">
              <div className="set-field">
                <label htmlFor="s-conv">Conversion</label>
                <Dropdown field id="s-conv" label="Conversion" icon={<PanelsTopLeft />} value={conversionId} onChange={setConversionId}
                  options={[{ value: "", label: "None: enter a site below" }, ...(conversions ?? []).map((c) => ({ value: c.id, label: c.business, hint: host(c.siteUrl) }))]} />
                <span className="hint">Reuses the conversion's WordPress connection and connector plugin.</span>
              </div>
            </div>
          </div>
        </section>

        {!conv && (
          <section className="set-section">
            <h3 className="set-title"><Globe />Or any live site</h3>
            <div className="set-body">
              <div className="set-grid">
                <div className="set-field"><label htmlFor="s-name">Site name</label><div className="input-icon"><Building2 /><input id="s-name" className="input" value={form.name} onChange={set("name")} placeholder="Client name" /></div></div>
                <div className="set-field"><label htmlFor="s-url">Live URL</label><div className="input-icon"><Globe /><input id="s-url" className="input" value={form.siteUrl} onChange={set("siteUrl")} placeholder="https://client-site.com" required /></div></div>
                <div className="set-field"><label htmlFor="s-user">WordPress username (optional)</label><div className="input-icon"><User /><input id="s-user" className="input" value={form.wpUser} onChange={set("wpUser")} autoComplete="off" /></div></div>
                <div className="set-field"><label htmlFor="s-pass">Application Password (optional)</label><div className="input-icon"><KeyRound /><input id="s-pass" className="input mono" type="password" value={form.appPassword} onChange={set("appPassword")} autoComplete="off" /></div>
                  <span className="hint">Audits work on any site. Applying fixes needs WordPress with the Studio Connector plugin.</span></div>
              </div>
            </div>
          </section>
        )}

        {error && <div className="banner err"><XCircle />{error}</div>}
        <div className="set-actions"><button className="btn btn-ink" disabled={busy || (!conv && !form.siteUrl)}>{busy ? "Adding…" : "Add site"} <ArrowRight /></button></div>
      </form>
    </>
  );
}
