import { useEffect, useState } from "react";
import { Link, useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
import { ArrowRight, Blocks, Crown, Globe, KeyRound, Puzzle, User, XCircle } from "lucide-react";
import type { WpConversion } from "../../../../shared/types";
import type { LayoutCtx } from "../../layout/Layout";
import { api, fileUrl } from "../../lib/api";
import { Dropdown } from "../../components/Dropdown";

export default function WpNew() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { builds, reloadAll } = useOutletContext<LayoutCtx>();
  const ready = (builds ?? []).filter((b) => b.status === "ready" || b.status === "needs_review");
  const [buildId, setBuildId] = useState(params.get("build") ?? "");
  const [siteUrl, setSiteUrl] = useState("");
  const [wpUser, setWpUser] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [pro, setPro] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!buildId && ready.length === 1) setBuildId(ready[0].id);
  }, [buildId, ready]);
  const build = ready.find((b) => b.id === buildId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const c = await api<WpConversion>("/api/wp", { method: "POST", json: { buildId, siteUrl, wpUser, appPassword, elementorPro: pro } });
      reloadAll();
      nav(`/wp/${c.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/wp/all">WordPress</Link><span className="sep">/</span><span className="here">New conversion</span></nav>
      <div className="title-row"><h1 className="page-title">Convert to WordPress</h1></div>

      <form className="set-stack" onSubmit={submit}>
        <section className="set-section">
          <h3 className="set-title"><Blocks />Website build</h3>
          <div className="set-body">
            <div className="set-grid">
              <div className="set-field">
                <label htmlFor="w-build">Convert</label>
                <Dropdown field id="w-build" label="Build" icon={<Blocks />} value={buildId} onChange={setBuildId}
                  options={[{ value: "", label: "Pick a finished build" }, ...ready.map((b) => ({ value: b.id, label: b.business, hint: `${b.pages.length} pages` }))]} />
                <span className="hint">Pages are converted in the build's order, starting with the homepage.</span>
              </div>
              {build && <div className="mockup-thumb"><img src={fileUrl(build.leadId, "mockup-desktop.jpg")} alt={`${build.business} homepage`} /></div>}
            </div>
          </div>
        </section>

        <section className="set-section">
          <h3 className="set-title"><Puzzle />Elementor scope</h3>
          <div className="set-body">
            <div className="option-grid" role="radiogroup" aria-label="Elementor Pro in scope">
              <button type="button" role="radio" aria-checked={!pro} className={`option-card${!pro ? " on" : ""}`} onClick={() => setPro(false)}>
                <span className="option-preview"><span className={`window-art${!pro ? " dark" : ""}`}><span className="dots"><i /><i /><i /></span><Puzzle /></span></span>
                <span className="option-foot"><Puzzle /><span>Elementor free + custom widgets</span><i className="radio" aria-hidden="true" /></span>
              </button>
              <button type="button" role="radio" aria-checked={pro} className={`option-card${pro ? " on" : ""}`} onClick={() => setPro(true)}>
                <span className="option-preview"><span className={`window-art${pro ? " dark" : ""}`}><span className="dots"><i /><i /><i /></span><Crown /></span></span>
                <span className="option-foot"><Crown /><span>Elementor Pro in scope</span><i className="radio" aria-hidden="true" /></span>
              </button>
            </div>
            <div className="set-card" style={{ fontSize: 14, lineHeight: 1.5 }}>
              {pro
                ? "Uses Pro widgets where they fit (Form, Nav Menu, Slides, Price Table…) and builds the header and footer as theme-builder templates shown site-wide."
                : "Uses only free widgets. Anything that would need Pro (a working form, a mobile nav menu, a slider…) becomes a custom Elementor widget, shipped inside the connector plugin and fully editable in Elementor."}
            </div>
          </div>
        </section>

        <section className="set-section">
          <h3 className="set-title"><Globe />Client WordPress site</h3>
          <div className="set-body">
            <div className="set-grid">
              <div className="set-field">
                <label htmlFor="w-url">Site URL</label>
                <div className="input-icon"><Globe /><input id="w-url" className="input" placeholder="https://client-site.com" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} required /></div>
              </div>
              <div className="set-field">
                <label htmlFor="w-user">WordPress username</label>
                <div className="input-icon"><User /><input id="w-user" className="input" autoComplete="off" value={wpUser} onChange={(e) => setWpUser(e.target.value)} required /></div>
              </div>
              <div className="set-field">
                <label htmlFor="w-pass">Application Password</label>
                <div className="input-icon"><KeyRound /><input id="w-pass" className="input mono" type="password" autoComplete="off" placeholder="xxxx xxxx xxxx xxxx xxxx xxxx" value={appPassword} onChange={(e) => setAppPassword(e.target.value)} /></div>
                <span className="hint">Users → Profile → Application Passwords in the client's WordPress. It isn't their login password, and you can revoke it any time. You can also add it later.</span>
              </div>
            </div>
          </div>
        </section>

        {error && <div className="banner err"><XCircle />{error}</div>}
        <div className="set-actions">
          <button className="btn btn-ink" disabled={busy || !buildId}>{busy ? "Creating…" : "Create conversion"} <ArrowRight /></button>
        </div>
      </form>
    </>
  );
}
