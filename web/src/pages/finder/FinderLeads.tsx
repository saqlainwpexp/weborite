import { useOutletContext, useSearchParams } from "react-router-dom";
import { useMemo, useRef, useState } from "react";
import { ArrowDownUp, CalendarDays, ChevronLeft, ChevronRight, Download, Gauge, Radar, Search, Sparkles, Trash2, X } from "lucide-react";
import type { Prospect } from "../../../../shared/types";
import { api } from "../../lib/api";
import type { LayoutCtx } from "../../layout/Layout";
import { ProspectsTable, type ProspectSortKey, type SortDir } from "../../components/finder";
import { Dropdown } from "../../components/Dropdown";
import { dayKey, parseDayKey } from "../../components/Calendar";

const FIT_FILTERS = [
  { key: "all", label: "Any fit" },
  { key: "hot", label: "Hot" },
  { key: "warm", label: "Warm" },
  { key: "cold", label: "Cold" },
];

const TAG_FILTERS = [
  { key: "all", label: "All" },
  { key: "email", label: "Email" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "both", label: "Both" },
  { key: "no-website", label: "No website" },
];

const SORTS: { key: ProspectSortKey; dir: SortDir; label: string }[] = [
  { key: "fit", dir: "desc", label: "Best fit first" },
  { key: "fit", dir: "asc", label: "Lowest fit first" },
  { key: "reviews", dir: "desc", label: "Most reviews" },
  { key: "reviews", dir: "asc", label: "Fewest reviews" },
  { key: "rating", dir: "desc", label: "Highest rating" },
  { key: "rating", dir: "asc", label: "Lowest rating" },
  { key: "name", dir: "asc", label: "Name A–Z" },
  { key: "name", dir: "desc", label: "Name Z–A" },
  { key: "found", dir: "desc", label: "Newest found" },
  { key: "found", dir: "asc", label: "Oldest found" },
];
const SORT_KEYS: ProspectSortKey[] = ["fit", "reviews", "rating", "name", "found"];
const PAGE_SIZES = [25, 50, 100];

/** The value a lead is sorted by; null (unscored, no reviews…) always sinks to the bottom. */
function sortValueOf(p: Prospect, key: ProspectSortKey): number | string | null {
  if (key === "fit") return p.fit?.status === "done" ? p.fit.score : null;
  if (key === "reviews") return p.reviews;
  if (key === "rating") return p.rating;
  if (key === "name") return p.name.toLowerCase();
  return p.createdAt;
}

/** Page numbers to show: first, last, and a window around the current page, with gaps as null. */
function pageList(page: number, pages: number): (number | null)[] {
  const keep = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  const out: (number | null)[] = [];
  let prev = 0;
  for (const n of [...keep].sort((a, b) => a - b)) {
    if (n - prev > 1) out.push(null);
    out.push(n);
    prev = n;
  }
  return out;
}

export default function FinderLeads() {
  const { prospects, searches, openAdd, reloadAll } = useOutletContext<LayoutCtx>();
  const [scoring, setScoring] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const searchId = params.get("search");
  const tag = params.get("tag") ?? "all";
  const date = params.get("date");
  const q = params.get("q") ?? "";
  const fit = params.get("fit") ?? "all";
  const sortKey: ProspectSortKey = SORT_KEYS.includes(params.get("sort") as ProspectSortKey) ? (params.get("sort") as ProspectSortKey) : "fit";
  const sortDir: SortDir = params.get("dir") === "asc" ? "asc" : params.get("dir") === "desc" ? "desc" : sortKey === "name" ? "asc" : "desc";
  const pageSize = PAGE_SIZES.includes(Number(params.get("size"))) ? Number(params.get("size")) : 50;
  const current = searches?.find((s) => s.id === searchId);

  const setMany = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    // Any change other than turning the page starts again from page 1.
    if (!("page" in patch)) next.delete("page");
    setParams(next, { replace: "q" in patch });
  };
  const set = (k: string, v: string | null) => setMany({ [k]: v });

  const needle = q.trim().toLowerCase();
  const shown = (prospects ?? []).filter((p) => {
    if (searchId && p.searchId !== searchId) return false;
    if (date && dayKey(p.createdAt) !== date) return false;
    if (tag === "both" && !(p.tags.includes("email") && p.tags.includes("whatsapp"))) return false;
    if (tag !== "all" && tag !== "both" && !p.tags.includes(tag)) return false;
    if (fit !== "all" && !(p.fit?.status === "done" && p.fit.grade === fit)) return false;
    if (needle && ![p.name, p.category, p.phone, p.website, p.address, p.emails.join(" ")].join(" ").toLowerCase().includes(needle)) return false;
    return true;
  });
  shown.sort((a, b) => {
    const x = sortValueOf(a, sortKey), y = sortValueOf(b, sortKey);
    if (x == null || y == null) return x == null && y == null ? b.createdAt.localeCompare(a.createdAt) : x == null ? 1 : -1;
    const c = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number);
    return (sortDir === "asc" ? c : -c) || b.createdAt.localeCompare(a.createdAt);
  });
  const onSort = (k: ProspectSortKey) => {
    const dir: SortDir = k === sortKey ? (sortDir === "asc" ? "desc" : "asc") : k === "name" ? "asc" : "desc";
    setMany({ sort: k === "fit" && dir === "desc" ? null : k, dir: k === "fit" && dir === "desc" ? null : dir });
  };

  // Pagination
  const pages = Math.max(1, Math.ceil(shown.length / pageSize));
  const page = Math.min(pages, Math.max(1, Number(params.get("page")) || 1));
  const pageRows = shown.slice((page - 1) * pageSize, page * pageSize);
  const goPage = (n: number) => setMany({ page: n > 1 ? String(n) : null });

  // Selection survives paging and filtering; ids of deleted leads drop out on their own.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const allIds = useMemo(() => new Set((prospects ?? []).map((p) => p.id)), [prospects]);
  const selected = useMemo(() => new Set([...picked].filter((id) => allIds.has(id))), [picked, allIds]);
  const lastClick = useRef<string | null>(null);
  const toggle = (id: string, range: boolean) => {
    const next = new Set(selected);
    const ids = pageRows.map((p) => p.id);
    const from = lastClick.current ? ids.indexOf(lastClick.current) : -1;
    const to = ids.indexOf(id);
    const on = !next.has(id);
    if (range && from >= 0 && to >= 0) for (const x of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) on ? next.add(x) : next.delete(x);
    else on ? next.add(id) : next.delete(id);
    lastClick.current = id;
    setPicked(next);
  };
  const togglePage = (ids: string[]) => {
    const next = new Set(selected);
    const all = ids.every((id) => next.has(id));
    for (const id of ids) all ? next.delete(id) : next.add(id);
    setPicked(next);
  };
  const selectedList = (prospects ?? []).filter((p) => selected.has(p.id));
  const allShownPicked = shown.length > 0 && shown.every((p) => selected.has(p.id));
  const pagePicked = pageRows.length > 0 && pageRows.every((p) => selected.has(p.id));
  const [busy, setBusy] = useState<string | null>(null);

  const bulkScore = async () => {
    const r = await api<{ queued: number }>("/api/finder/qualify", { method: "POST", json: { ids: [...selected] } });
    setScoring(`Scoring ${r.queued} selected lead${r.queued === 1 ? "" : "s"} in the background.`);
    reloadAll();
  };
  const bulkMockups = async () => {
    const todo = selectedList.filter((p) => !p.mockupLeadId);
    if (!todo.length) return setScoring("All the selected leads already have a mockup.");
    if (!confirm(`Start ${todo.length} mockup${todo.length === 1 ? "" : "s"}? Each one uses Claude.${todo.length < selectedList.length ? ` ${selectedList.length - todo.length} already have one and are skipped.` : ""}`)) return;
    for (let i = 0; i < todo.length; i++) {
      setBusy(`Starting mockups… ${i + 1}/${todo.length}`);
      await api(`/api/finder/prospects/${todo[i].id}/mockup`, { method: "POST", json: {} }).catch(() => {});
    }
    setBusy(null);
    setScoring(`${todo.length} mockup${todo.length === 1 ? "" : "s"} queued in the Mockups workspace.`);
    reloadAll();
  };
  const bulkDelete = async () => {
    if (!confirm(`Delete ${selected.size} lead${selected.size === 1 ? "" : "s"}? This can't be undone.`)) return;
    setBusy("Deleting…");
    await api("/api/finder/prospects/delete", { method: "POST", json: { ids: [...selected] } });
    setBusy(null);
    setPicked(new Set());
    reloadAll();
  };
  const unscored = (prospects ?? []).filter((p) => !p.fit || p.fit.status === "failed").length;
  const scoreAll = async () => {
    const r = await api<{ queued: number }>("/api/finder/qualify", { method: "POST" });
    setScoring(`Scoring ${r.queued} lead${r.queued === 1 ? "" : "s"}: each website is audited and its design reviewed. This runs in the background.`);
    reloadAll();
  };

  const exportUrl = `/api/finder/export.csv?${new URLSearchParams({ ...(searchId ? { search: searchId } : {}), ...(tag !== "all" && tag !== "both" ? { tag } : {}) })}`;
  const selectedExportUrl = `/api/finder/export.csv?${new URLSearchParams({ ids: [...selected].join(",") })}`;
  const sortValue = `${sortKey}:${sortDir}`;
  const searchOptions = [
    { value: "", label: "All searches", hint: `${prospects?.length ?? 0} leads`, swatch: "" },
    ...(searches ?? []).map((s) => ({ value: s.id, label: s.query, hint: `${s.found} leads`, swatch: s.color })),
  ];

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <span>Lead Finder</span><span className="sep">/</span><span className={current ? undefined : "here"}>Leads</span>
        {current && <><span className="sep">/</span><span className="here">{current.query}</span></>}
      </nav>
      <div className="title-row">
        <h1 className="page-title">{current ? current.query : "Leads"}</h1>
        <div className="actions">
          <Dropdown label="Filter by search" icon={<Radar />} value={searchId ?? ""} options={searchOptions} onChange={(v) => set("search", v || null)} align="right" width={300} />
          {unscored > 0 && <button className="btn btn-white" onClick={() => void scoreAll()}><Gauge />Score {unscored} lead{unscored === 1 ? "" : "s"}</button>}
          <a className="btn btn-white" href={exportUrl}><Download />Export CSV</a>
          <button className="btn btn-ink" onClick={openAdd}>Find leads</button>
        </div>
      </div>

      {scoring && <div className="banner" style={{ background: "var(--accent-softer)", color: "var(--text)" }}><Gauge />{scoring}</div>}
      <div className="filter-bar">
        <div className="seg" role="tablist" aria-label="Filter by fit">
          {FIT_FILTERS.map((f) => (
            <button key={f.key} role="tab" aria-selected={fit === f.key} className={fit === f.key ? "on" : ""} onClick={() => set("fit", f.key === "all" ? null : f.key)}>{f.label}</button>
          ))}
        </div>
        <div className="seg" role="tablist" aria-label="Filter by tag">
          {TAG_FILTERS.map((f) => (
            <button key={f.key} role="tab" aria-selected={tag === f.key} className={tag === f.key ? "on" : ""} onClick={() => set("tag", f.key === "all" ? null : f.key)}>{f.label}</button>
          ))}
        </div>
        <div className="input-icon filter-search">
          <Search />
          <input className="input" placeholder="Filter by name, phone, email…" value={q} onChange={(e) => set("q", e.target.value || null)} aria-label="Filter leads" />
        </div>
        {date && (
          <span className="filter-chip">
            <CalendarDays />Found {parseDayKey(date).toLocaleDateString("en-US", { month: "long", day: "numeric" })}
            <button type="button" aria-label="Clear date filter" onClick={() => set("date", null)}><X /></button>
          </span>
        )}
        <Dropdown label="Sort leads" icon={<ArrowDownUp />} value={sortValue} align="right" width={220}
          options={SORTS.map((o) => ({ value: `${o.key}:${o.dir}`, label: o.label }))}
          onChange={(v) => { const [k, d] = v.split(":"); setMany({ sort: k === "fit" && d === "desc" ? null : k, dir: k === "fit" && d === "desc" ? null : d }); }} />
        <span className="muted" style={{ marginLeft: "auto" }}>{shown.length.toLocaleString("en-US")} lead{shown.length === 1 ? "" : "s"}</span>
      </div>

      {selected.size > 0 && (
        <div className="bulk-bar" role="region" aria-label="Selected leads">
          <b>{selected.size.toLocaleString("en-US")} selected</b>
          {pagePicked && !allShownPicked && shown.length > pageRows.length && (
            <button type="button" className="link-btn" onClick={() => setPicked(new Set([...selected, ...shown.map((p) => p.id)]))}>Select all {shown.length.toLocaleString("en-US")} leads</button>
          )}
          <span className="bulk-actions">
            {busy ? <span className="muted">{busy}</span> : (
              <>
                <button type="button" className="btn btn-sm btn-white" onClick={() => void bulkScore()}><Gauge />Score</button>
                <button type="button" className="btn btn-sm btn-white" onClick={() => void bulkMockups()}><Sparkles />Create mockups</button>
                <a className="btn btn-sm btn-white" href={selectedExportUrl}><Download />Export</a>
                <button type="button" className="btn btn-sm btn-white danger" onClick={() => void bulkDelete()}><Trash2 />Delete</button>
                <button type="button" className="btn btn-sm btn-chip" onClick={() => setPicked(new Set())}>Clear</button>
              </>
            )}
          </span>
        </div>
      )}

      <div className="card card-lg">
        <ProspectsTable prospects={pageRows} searches={searches ?? []} selection={{ selected, toggle, togglePage }} sort={{ key: sortKey, dir: sortDir }} onSort={onSort} />
        {shown.length > PAGE_SIZES[0] && (
          <nav className="pager" aria-label="Pages">
            <span className="muted">{((page - 1) * pageSize + 1).toLocaleString("en-US")}–{Math.min(page * pageSize, shown.length).toLocaleString("en-US")} of {shown.length.toLocaleString("en-US")}</span>
            <span className="pager-pages">
              <button type="button" className="btn btn-sm btn-icon btn-chip" aria-label="Previous page" disabled={page <= 1} onClick={() => goPage(page - 1)}><ChevronLeft /></button>
              {pageList(page, pages).map((n, i) => n === null
                ? <span key={`gap${i}`} className="muted" aria-hidden="true">…</span>
                : <button key={n} type="button" className={`btn btn-sm btn-chip pager-num${n === page ? " on" : ""}`} aria-current={n === page ? "page" : undefined} onClick={() => goPage(n)}>{n}</button>)}
              <button type="button" className="btn btn-sm btn-icon btn-chip" aria-label="Next page" disabled={page >= pages} onClick={() => goPage(page + 1)}><ChevronRight /></button>
            </span>
            <label className="pager-size muted">
              Per page
              <select className="input" value={pageSize} onChange={(e) => setMany({ size: e.target.value === "50" ? null : e.target.value })}>
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </nav>
        )}
      </div>
    </>
  );
}
