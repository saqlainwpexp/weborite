import { useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { ArrowUpRight, ChevronDown, Pencil, Trash2, Plus } from "lucide-react";
import type { BenchmarkSet } from "../../../shared/types";
import type { LayoutCtx } from "../layout/Layout";
import { api, host, shortDate } from "../lib/api";
import { Modal } from "../components/ui";

function EditSet({ set, onClose, onSaved }: { set: BenchmarkSet; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState(set);
  const [busy, setBusy] = useState(false);
  const upd = (i: number, k: "name" | "url" | "why", v: string) =>
    setDraft({ ...draft, sites: draft.sites.map((s, n) => (n === i ? { ...s, [k]: v } : s)) });

  async function save() {
    setBusy(true);
    await api(`/api/benchmarks/${set.vertical}`, { method: "PUT", json: { ...draft, sites: draft.sites.filter((s) => s.name && s.url) } });
    onSaved();
  }

  return (
    <Modal title={`Edit ${set.label}`} onClose={onClose}>
      <div className="form" style={{ maxHeight: "60vh", overflow: "auto", paddingRight: 4 }}>
        <div className="input-group">
          <label htmlFor="b-label">Label</label>
          <input id="b-label" className="input" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
        </div>
        <div className="input-group">
          <label htmlFor="b-reg">Competitive register</label>
          <input id="b-reg" className="input" value={draft.register} onChange={(e) => setDraft({ ...draft, register: e.target.value })} />
          <span className="hint">What the buyer is actually evaluating</span>
        </div>
        {draft.sites.map((s, i) => (
          <div key={i} className="inset" style={{ padding: 14, display: "grid", gap: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 36px", gap: 8 }}>
              <input className="input" aria-label="Site name" value={s.name} onChange={(e) => upd(i, "name", e.target.value)} placeholder="Name" />
              <input className="input" aria-label="Site URL" value={s.url} onChange={(e) => upd(i, "url", e.target.value)} placeholder="https://" />
              <button className="icon-btn" style={{ width: 36, height: 48, background: "#fff" }} aria-label="Remove site" onClick={() => setDraft({ ...draft, sites: draft.sites.filter((_, n) => n !== i) })}><Trash2 /></button>
            </div>
            <input className="input" aria-label="Why it's a benchmark" value={s.why} onChange={(e) => upd(i, "why", e.target.value)} placeholder="Why it's a benchmark" />
          </div>
        ))}
        <button className="btn btn-chip" onClick={() => setDraft({ ...draft, sites: [...draft.sites, { name: "", url: "", why: "" }] })}><Plus />Add site</button>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}>
        <button className="btn btn-chip" onClick={onClose}>Cancel</button>
        <button className="btn btn-ink btn-wide" onClick={save} disabled={busy}>Save set</button>
      </div>
    </Modal>
  );
}

export default function Benchmarks() {
  const { benchmarks, reloadAll } = useOutletContext<LayoutCtx>();
  const [editing, setEditing] = useState<BenchmarkSet | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (k: string) => {
    const next = new Set(open);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setOpen(next);
  };
  const nav = useNavigate();

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span className="here">Benchmarks</span></nav>
      <div className="title-row">
        <h1 className="page-title">Benchmarks</h1>
      </div>
      <p className="muted" style={{ maxWidth: 640, marginTop: -8 }}>
        Real best-in-class homepages for each vertical. Each set is researched once and reused for every later lead in that vertical.
      </p>

      {!benchmarks?.length && (
        <div className="card card-lg empty">
          <h4>No benchmark sets yet</h4>
          <p>The first diagnosed lead in each vertical creates its set automatically.</p>
        </div>
      )}

      <div className="acc-grid">
        {(benchmarks ?? []).map((b) => {
          const isOpen = open.has(b.vertical);
          const panelId = `bench-${b.vertical}`;
          return (
            <section key={b.vertical} className={`acc${isOpen ? " open" : ""}`}>
              <button type="button" className="acc-head" aria-expanded={isOpen} aria-controls={panelId} onClick={() => toggle(b.vertical)}>
                <span className="sq" style={{ background: b.color }} />
                <span className="acc-title">
                  <b>{b.label}</b>
                  <small>{b.sites.length} references · {b.leadCount} lead{b.leadCount === 1 ? "" : "s"}</small>
                </span>
                <ChevronDown className="acc-chevron" />
              </button>
              {isOpen && (
                <div className="acc-body" id={panelId}>
                  <ul className="ref-list">
                    {b.sites.map((s) => (
                      <li key={s.url}>
                        <a href={s.url} target="_blank" rel="noreferrer" title={s.why}>
                          <span className="ref-name">{s.name}</span>
                          <span className="ref-host">{host(s.url)}</span>
                          <ArrowUpRight />
                        </a>
                      </li>
                    ))}
                  </ul>
                  <div className="acc-foot">
                    <span className="muted" style={{ whiteSpace: "nowrap" }}>Built {new Date(b.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="btn btn-chip btn-xs" onClick={() => nav(`/leads?vertical=${b.vertical}`)}>View leads</button>
                      <button className="btn btn-chip btn-xs" onClick={() => setEditing(b)}><Pencil size={13} />Edit</button>
                    </div>
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>

      {editing && <EditSet set={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reloadAll(); }} />}
    </>
  );
}
