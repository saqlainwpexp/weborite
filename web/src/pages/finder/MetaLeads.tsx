import { useOutletContext, useNavigate, useSearchParams } from "react-router-dom";
import { useMemo, useRef, useState } from "react";
import { ArrowRight, Download, Mail, Megaphone, Phone, Search, Trash2, Upload, UserPlus } from "lucide-react";
import type { MetaLead, MetaLeadStatus } from "../../../../shared/types";
import { META_LEAD_STATUS } from "../../../../shared/types";
import { api, timeAgo } from "../../lib/api";
import type { LayoutCtx } from "../../layout/Layout";
import { Modal } from "../../components/ui";

const SOURCE_LABEL: Record<MetaLead["source"], string> = { facebook: "Facebook/Instagram", csv: "Imported", manual: "Added by hand" };
const STATUS_DOT: Record<MetaLeadStatus, string> = {
  new: "#3f7cc9", contacted: "#c98a2b", qualified: "#886fe2", won: "#4f9a6e", lost: "var(--faint)",
};

export function MetaStatusPill({ status }: { status: MetaLeadStatus }) {
  const label = META_LEAD_STATUS.find((s) => s.key === status)?.label ?? status;
  return <span className="status" style={{ background: "var(--accent-softer)", color: "var(--text)" }}><span className="dot" style={{ background: STATUS_DOT[status] }} />{label}</span>;
}

function AddMetaLeadModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [form, setForm] = useState({ name: "", email: "", phone: "", company: "", campaign: "", platform: "", notes: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<MetaLead>("/api/meta/leads", { method: "POST", json: form });
      onDone(r.id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Add a lead" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="form-row">
          <div className="input-group"><label htmlFor="m-name">Name</label><input id="m-name" className="input" value={form.name} onChange={set("name")} autoFocus /></div>
          <div className="input-group"><label htmlFor="m-company">Company</label><input id="m-company" className="input" value={form.company} onChange={set("company")} /></div>
        </div>
        <div className="form-row">
          <div className="input-group"><label htmlFor="m-email">Email</label><input id="m-email" type="email" className="input" value={form.email} onChange={set("email")} /></div>
          <div className="input-group"><label htmlFor="m-phone">Phone</label><input id="m-phone" className="input" value={form.phone} onChange={set("phone")} /></div>
        </div>
        <div className="form-row">
          <div className="input-group"><label htmlFor="m-campaign">Campaign</label><input id="m-campaign" className="input" value={form.campaign} onChange={set("campaign")} placeholder="e.g. Spring promo" /></div>
          <div className="input-group"><label htmlFor="m-platform">Platform</label><input id="m-platform" className="input" value={form.platform} onChange={set("platform")} placeholder="facebook, instagram…" /></div>
        </div>
        <div className="input-group"><label htmlFor="m-notes">Notes</label><textarea id="m-notes" className="input" rows={3} value={form.notes} onChange={set("notes")} /></div>
        <span className="hint">Give at least a name, email or phone.</span>
        {error && <p className="error-text">{error}</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}>
          <button type="button" className="btn btn-chip" onClick={onClose}>Cancel</button>
          <button className="btn btn-ink btn-wide" disabled={busy}>{busy ? "Adding…" : "Add lead"}</button>
        </div>
      </form>
    </Modal>
  );
}

function ImportCsvModal({ onClose, onDone }: { onClose: () => void; onDone: (r: { imported: number; skipped: number }) => void }) {
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function readFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ""));
    reader.readAsText(f);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await api<{ imported: number; skipped: number }>("/api/meta/leads/import", { method: "POST", json: { csv } }));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Import leads from CSV" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="hint" style={{ marginTop: 0 }}>
          Export your leads from Meta Ads / Lead Center (or any ad platform) and upload the CSV. Columns like
          <b> full name</b>, <b>email</b>, <b>phone number</b>, <b>campaign name</b> and <b>platform</b> are matched automatically; any other column is kept as a form answer.
        </p>
        <div className="input-group">
          <label className="btn btn-white" style={{ alignSelf: "flex-start", cursor: "pointer" }}>
            <Upload />{fileName || "Choose CSV file"}
            <input type="file" accept=".csv,text/csv" onChange={readFile} style={{ display: "none" }} />
          </label>
        </div>
        <div className="input-group">
          <label htmlFor="m-csv">…or paste CSV</label>
          <textarea id="m-csv" className="input" rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="full name,email,phone number,campaign name&#10;Jane Doe,jane@acme.com,+1 555 0100,Spring promo" style={{ fontFamily: "monospace", fontSize: 13 }} />
        </div>
        {error && <p className="error-text">{error}</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}>
          <button type="button" className="btn btn-chip" onClick={onClose}>Cancel</button>
          <button className="btn btn-ink btn-wide" disabled={busy || !csv.trim()}>{busy ? "Importing…" : "Import"}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function MetaLeads() {
  const { metaLeads, reloadAll } = useOutletContext<LayoutCtx>();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "all";
  const q = params.get("q") ?? "";
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    v ? next.set(k, v) : next.delete(k);
    setParams(next, { replace: k === "q" });
  };

  const needle = q.trim().toLowerCase();
  const shown = (metaLeads ?? []).filter((l) => {
    if (status !== "all" && l.status !== status) return false;
    if (needle && ![l.name, l.email, l.phone, l.company, l.campaign, l.platform].join(" ").toLowerCase().includes(needle)) return false;
    return true;
  });

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const allIds = useMemo(() => new Set((metaLeads ?? []).map((l) => l.id)), [metaLeads]);
  const selected = useMemo(() => new Set([...picked].filter((id) => allIds.has(id))), [picked, allIds]);
  const lastClick = useRef<string | null>(null);
  const toggle = (id: string, range: boolean) => {
    const next = new Set(selected);
    const ids = shown.map((l) => l.id);
    const from = lastClick.current ? ids.indexOf(lastClick.current) : -1;
    const to = ids.indexOf(id);
    const on = !next.has(id);
    if (range && from >= 0 && to >= 0) for (const x of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) on ? next.add(x) : next.delete(x);
    else on ? next.add(id) : next.delete(id);
    lastClick.current = id;
    setPicked(next);
  };
  const pageIds = shown.map((l) => l.id);
  const onPage = pageIds.filter((id) => selected.has(id)).length;
  const togglePage = () => {
    const next = new Set(selected);
    const all = pageIds.every((id) => next.has(id));
    for (const id of pageIds) all ? next.delete(id) : next.add(id);
    setPicked(next);
  };

  const bulkDelete = async () => {
    if (!confirm(`Delete ${selected.size} lead${selected.size === 1 ? "" : "s"}? This can't be undone.`)) return;
    await api("/api/meta/leads/delete", { method: "POST", json: { ids: [...selected] } });
    setPicked(new Set());
    reloadAll();
  };

  const STATUS_TABS = [{ key: "all", label: "All" }, ...META_LEAD_STATUS];
  const countFor = (key: string) => (key === "all" ? (metaLeads ?? []).length : (metaLeads ?? []).filter((l) => l.status === key).length);
  const exportUrl = selected.size ? `/api/meta/export.csv?ids=${[...selected].join(",")}` : "/api/meta/export.csv";

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span>Lead Finder</span><span className="sep">/</span><span className="here">Meta leads</span></nav>
      <div className="title-row">
        <h1 className="page-title">Meta leads</h1>
        <div className="actions">
          <button className="btn btn-white" onClick={() => setImporting(true)}><Upload />Import CSV</button>
          <a className="btn btn-white" href={exportUrl}><Download />Export CSV</a>
          <button className="btn btn-ink" onClick={() => setAdding(true)}><UserPlus />Add lead</button>
        </div>
      </div>

      {toast && <div className="banner" style={{ background: "var(--accent-softer)", color: "var(--text)" }}><Megaphone />{toast}</div>}

      <div className="filter-bar">
        <div className="seg" role="tablist" aria-label="Filter by status">
          {STATUS_TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={status === t.key} className={status === t.key ? "on" : ""} onClick={() => set("status", t.key === "all" ? null : t.key)}>
              {t.label}<span className="muted" style={{ marginLeft: 6 }}>{countFor(t.key)}</span>
            </button>
          ))}
        </div>
        <div className="input-icon filter-search">
          <Search />
          <input className="input" placeholder="Filter by name, email, phone, campaign…" value={q} onChange={(e) => set("q", e.target.value || null)} aria-label="Filter leads" />
        </div>
        <span className="muted" style={{ marginLeft: "auto" }}>{shown.length.toLocaleString("en-US")} lead{shown.length === 1 ? "" : "s"}</span>
      </div>

      {selected.size > 0 && (
        <div className="bulk-bar" role="region" aria-label="Selected leads">
          <b>{selected.size.toLocaleString("en-US")} selected</b>
          <span className="bulk-actions">
            <a className="btn btn-sm btn-white" href={exportUrl}><Download />Export</a>
            <button type="button" className="btn btn-sm btn-white danger" onClick={() => void bulkDelete()}><Trash2 />Delete</button>
            <button type="button" className="btn btn-sm btn-chip" onClick={() => setPicked(new Set())}>Clear</button>
          </span>
        </div>
      )}

      <div className="card card-lg">
        {!metaLeads ? (
          <div className="empty"><p>Loading…</p></div>
        ) : !shown.length ? (
          <div className="empty">
            <h4>No Meta leads yet</h4>
            <p>Leads from your Facebook/Instagram lead ads land here automatically once the Meta webhook is connected. You can also import a CSV export or add one by hand.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="col-check">
                    <input type="checkbox" aria-label="Select all leads" checked={onPage > 0 && onPage === pageIds.length} ref={(el) => { if (el) el.indeterminate = onPage > 0 && onPage < pageIds.length; }} onChange={togglePage} />
                  </th>
                  <th>Lead</th>
                  <th className="hide-sm">Contact</th>
                  <th className="hide-sm">Source</th>
                  <th>Status</th>
                  <th className="hide-sm">Received</th>
                  <th aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {shown.map((l) => {
                  const isPicked = selected.has(l.id);
                  return (
                    <tr key={l.id} className={`row${isPicked ? " picked" : ""}`} onClick={() => nav(`/finder/meta/${l.id}`)}>
                      <td className="col-check" onClick={(e) => { e.stopPropagation(); toggle(l.id, e.shiftKey); }}>
                        <input type="checkbox" aria-label={`Select ${l.name || l.email || "lead"}`} checked={isPicked} readOnly tabIndex={0} onKeyDown={(e) => { if (e.key === " ") { e.preventDefault(); toggle(l.id, e.shiftKey); } }} />
                      </td>
                      <td className="col-biz">
                        <div className="lead-cell">
                          <span className="biz-mark" aria-hidden="true">{(l.name || l.email || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase() || "•"}</span>
                          <div style={{ minWidth: 0 }}>
                            <b>{l.name || l.email || l.phone || "Unnamed lead"}</b>
                            <span>{l.company || l.campaign || "Lead ad"}</span>
                          </div>
                        </div>
                      </td>
                      <td className="hide-sm">
                        <div style={{ display: "grid", gap: 2, fontSize: 13 }}>
                          {l.email && <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Mail size={13} />{l.email}</span>}
                          {l.phone && <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} className="muted"><Phone size={13} />{l.phone}</span>}
                          {!l.email && !l.phone && <span className="muted">—</span>}
                        </div>
                      </td>
                      <td className="hide-sm"><span className="muted">{SOURCE_LABEL[l.source]}</span></td>
                      <td><MetaStatusPill status={l.status} /></td>
                      <td className="hide-sm nowrap muted">{timeAgo(l.submittedAt ?? l.createdAt)}</td>
                      <td style={{ textAlign: "right" }}><span className="btn btn-sm btn-icon btn-chip" aria-hidden="true"><ArrowRight /></span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {adding && <AddMetaLeadModal onClose={() => setAdding(false)} onDone={(id) => { setAdding(false); reloadAll(); nav(`/finder/meta/${id}`); }} />}
      {importing && (
        <ImportCsvModal
          onClose={() => setImporting(false)}
          onDone={(r) => {
            setImporting(false);
            reloadAll();
            setToast(`Imported ${r.imported} lead${r.imported === 1 ? "" : "s"}${r.skipped ? `, skipped ${r.skipped} duplicate${r.skipped === 1 ? "" : "s"}` : ""}.`);
          }}
        />
      )}
    </>
  );
}
