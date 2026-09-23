import { useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { ArrowRight, Globe, Palette, Plus, Type, XCircle } from "lucide-react";
import type { CommsService } from "../../../../shared/types";
import type { LayoutCtx } from "../../layout/Layout";
import { api } from "../../lib/api";
import { desktop, PRESETS } from "../../lib/desktop";

export default function CommsAdd() {
  const nav = useNavigate();
  const { commsServices, reloadAll } = useOutletContext<LayoutCtx>();
  const [custom, setCustom] = useState({ name: "", url: "", color: "#6b6b6b" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = commsServices ?? [];

  async function add(body: Partial<CommsService>) {
    setBusy(true);
    setError(null);
    try {
      // A second account of the same service gets a numbered name and its own profile.
      const same = list.filter((s) => s.kind === body.kind && body.kind !== "custom").length;
      const s = await api<CommsService>("/api/comms", { method: "POST", json: { ...body, name: same ? `${body.name} ${same + 1}` : body.name } });
      await desktop?.comms.sync();
      reloadAll();
      nav(`/comms/${s.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const groups = [...new Set(PRESETS.map((p) => p.group))];
  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/comms">Communication</Link><span className="sep">/</span><span className="here">Add channel</span></nav>
      <div className="title-row"><h1 className="page-title">Add a channel</h1></div>
      {error && <div className="banner err"><XCircle />{error}</div>}
      <div className="set-stack">
        {groups.map((g) => (
          <section key={g} className="set-section">
            <h3 className="set-title">{g}</h3>
            <div className="set-body">
              <div className="preset-grid">
                {PRESETS.filter((p) => p.group === g).map((p) => {
                  const n = list.filter((s) => s.kind === p.kind).length;
                  return (
                    <button key={p.kind} type="button" className="preset-card" disabled={busy} onClick={() => void add({ kind: p.kind, name: p.name, url: p.url, color: p.color })}>
                      <span className="ch-tile" style={{ width: 36, height: 36, background: p.color }} aria-hidden="true">{p.name.slice(0, 1)}</span>
                      <span className="preset-main"><b>{p.name}</b><small className="muted">{n ? `${n} added · add another account` : new URL(p.url).hostname.replace(/^www\./, "")}</small></span>
                      <Plus size={16} className="muted" />
                    </button>
                  );
                })}
              </div>
            </div>
          </section>
        ))}
        <section className="set-section">
          <h3 className="set-title">Any other site</h3>
          <div className="set-body">
            <form className="set-grid" onSubmit={(e) => { e.preventDefault(); void add({ kind: "custom", ...custom }); }}>
              <div className="set-field"><label htmlFor="cm-name">Name</label><div className="input-icon"><Type /><input id="cm-name" className="input" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} placeholder="Client portal" required /></div></div>
              <div className="set-field"><label htmlFor="cm-url">Web address</label><div className="input-icon"><Globe /><input id="cm-url" className="input" value={custom.url} onChange={(e) => setCustom({ ...custom, url: e.target.value })} placeholder="https://app.example.com/inbox" required /></div></div>
              <div className="set-field"><label htmlFor="cm-color">Colour</label><div className="input-icon"><Palette /><input id="cm-color" className="input mono" value={custom.color} onChange={(e) => setCustom({ ...custom, color: e.target.value })} /></div></div>
              <div className="set-field" style={{ justifyContent: "flex-end" }}><label aria-hidden="true">&nbsp;</label><button className="btn btn-ink" disabled={busy}>Add <ArrowRight /></button></div>
            </form>
          </div>
        </section>
      </div>
    </>
  );
}
