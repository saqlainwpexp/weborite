import { useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { ArrowRight, CalendarDays, Download, Flame, Layers, Pencil, Trash2, X } from "lucide-react";
import type { LayoutCtx } from "../layout/Layout";
import { LeadsTable } from "../components/LeadsTable";
import { Dropdown } from "../components/Dropdown";
import { dayKey, parseDayKey } from "../components/Calendar";
import { api } from "../lib/api";

const FILTERS = [
  { key: "all", label: "All statuses" },
  { key: "ready", label: "Ready" },
  { key: "active", label: "In progress" },
  { key: "review", label: "Needs review" },
];

export default function Leads() {
  const { leads, benchmarks, openAdd, reloadAll } = useOutletContext<LayoutCtx>();
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editOpen, setEditOpen] = useState(false);
  const [edit, setEdit] = useState({ business: "", email: "", phone: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const vertical = params.get("vertical");
  const status = params.get("status") ?? "all";
  const temp = params.get("temp") ?? "all";
  const date = params.get("date");
  const v = benchmarks?.find((b) => b.vertical === vertical);

  const shown = (leads ?? [])
    .filter((l) => {
      if (vertical && l.vertical !== vertical) return false;
      if (date && dayKey(l.createdAt) !== date) return false;
      if (temp !== "all" && (l.temp ?? "") !== temp) return false;
      if (status === "ready") return l.status === "ready";
      if (status === "active") return ["queued", "running", "paused"].includes(l.status);
      if (status === "review") return ["needs_review", "failed"].includes(l.status);
      return true;
    })
    // When filtering by temperature, show the hottest first.
    .sort((a, b) => (temp === "all" ? 0 : (b.score ?? 0) - (a.score ?? 0)));

  const set = (k: string, val: string | null) => {
    const next = new URLSearchParams(params);
    if (val) next.set(k, val);
    else next.delete(k);
    setParams(next);
  };

  const ids = [...selected];
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const toggleAll = (on: boolean) =>
    setSelected(on ? new Set(shown.map((l) => l.id)) : new Set());
  const clearSel = () => setSelected(new Set());

  async function bulkDelete() {
    if (!ids.length || !confirm(`Delete ${ids.length} lead${ids.length === 1 ? "" : "s"} and all their files?`)) return;
    setBusy(true); setErr(null);
    try {
      await api("/api/leads/bulk", { method: "POST", json: { ids, action: "delete" } });
      clearSel(); reloadAll();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function bulkExport() {
    if (!ids.length) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/leads/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? "Export failed");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `mockups-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  function openEdit() {
    setEdit({ business: "", email: "", phone: "" });
    setErr(null);
    setEditOpen(true);
  }

  async function saveEdit() {
    const patch = Object.fromEntries(Object.entries(edit).filter(([, v]) => v.trim()));
    if (!Object.keys(patch).length) { setEditOpen(false); return; }
    setBusy(true); setErr(null);
    try {
      await api("/api/leads/bulk", { method: "PATCH", json: { ids, patch } });
      setEditOpen(false); clearSel(); reloadAll();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const verticalOptions = [
    { value: "", label: "All verticals", hint: `${leads?.length ?? 0} leads`, swatch: "" },
    ...(benchmarks ?? []).map((b) => ({ value: b.vertical, label: b.label, hint: `${b.leadCount} lead${b.leadCount === 1 ? "" : "s"}`, swatch: b.color })),
  ];
  const dateLabel = date ? parseDayKey(date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "";

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <span>Leads</span>
        {v && <><span className="sep">/</span><span className="here">{v.label}</span></>}
      </nav>
      <div className="title-row">
        <h1 className="page-title">{v ? v.label : "Leads"}</h1>
        <div className="actions">
          <Dropdown label="Filter by vertical" icon={<Layers />} value={vertical ?? ""} options={verticalOptions} onChange={(val) => set("vertical", val || null)} align="right" />
          <Dropdown
            label="Filter by score"
            icon={<Flame />}
            value={temp === "all" ? "" : temp}
            options={[
              { value: "", label: "All scores", hint: `${leads?.length ?? 0} leads`, swatch: "" },
              { value: "hot", label: "Hot", hint: "Chase today · 70+", swatch: "#e0564f" },
              { value: "warm", label: "Warm", hint: "Worth a nudge · 45–69", swatch: "#e0a33a" },
              { value: "cold", label: "Cold", hint: "Low priority · under 45", swatch: "#6b7cae" },
            ]}
            onChange={(val) => set("temp", val || null)}
            align="right"
          />
          <div className="seg" role="tablist" aria-label="Filter by status">
            {FILTERS.map((f) => (
              <button key={f.key} role="tab" aria-selected={status === f.key} className={status === f.key ? "on" : ""} onClick={() => set("status", f.key === "all" ? null : f.key)}>{f.label}</button>
            ))}
          </div>
          <button className="btn btn-ink" onClick={openAdd}>New mockup <ArrowRight /></button>
        </div>
      </div>

      {date && (
        <div className="filter-row">
          <span className="filter-chip">
            <CalendarDays />Received {dateLabel}
            <button type="button" aria-label="Clear date filter" onClick={() => set("date", null)}><X /></button>
          </span>
          <span className="muted">{shown.length} lead{shown.length === 1 ? "" : "s"}</span>
        </div>
      )}

      {selected.size > 0 && (
        <div className="filter-row bulk-bar">
          <span className="filter-chip"><Layers />{selected.size} selected
            <button type="button" aria-label="Clear selection" onClick={clearSel}><X /></button>
          </span>
          <span className="bulk-actions">
            <button className="btn btn-white btn-sm" onClick={openEdit} disabled={busy}><Pencil />Edit</button>
            <button className="btn btn-white btn-sm" onClick={() => void bulkExport()} disabled={busy}><Download />Export</button>
            <button className="btn btn-white btn-sm danger" onClick={() => void bulkDelete()} disabled={busy}><Trash2 />Delete</button>
          </span>
        </div>
      )}

      {err && <div className="banner err"><X />{err}</div>}

      <div className="card card-lg">
        {date && !shown.length ? (
          <div className="empty">
            <h4>No leads on {dateLabel}</h4>
            <p>Pick another day from the calendar in the top bar, or clear the filter.</p>
          </div>
        ) : (
          <LeadsTable leads={shown} benchmarks={benchmarks ?? []} selectable selected={selected} onToggle={toggle} onToggleAll={toggleAll} />
        )}
      </div>

      {editOpen && (
        <div className="backdrop" onClick={() => setEditOpen(false)}>
          <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Edit selected leads">
            <div className="card-head">
              <div>
                <h3 className="card-title">Edit {selected.size} lead{selected.size === 1 ? "" : "s"}</h3>
                <p className="card-sub" style={{ margin: "2px 0 0" }}>Only the fields you fill in change; leave a field blank to keep it as is.</p>
              </div>
              <button type="button" className="icon-btn" aria-label="Close" onClick={() => setEditOpen(false)}><X /></button>
            </div>
            <label className="pitch-field"><span>Business</span><input className="input" value={edit.business} onChange={(e) => setEdit({ ...edit, business: e.target.value })} placeholder="Leave blank to keep" /></label>
            <label className="pitch-field"><span>Email</span><input className="input" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} placeholder="Leave blank to keep" /></label>
            <label className="pitch-field"><span>Phone</span><input className="input" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} placeholder="Leave blank to keep" /></label>
            <div className="foot" style={{ justifyContent: "flex-end", gap: 12 }}>
              <button type="button" className="btn btn-white" onClick={() => setEditOpen(false)}>Cancel</button>
              <button type="button" className="btn btn-ink" onClick={() => void saveEdit()} disabled={busy}>Save changes</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
