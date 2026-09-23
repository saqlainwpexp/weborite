import { useOutletContext, useSearchParams } from "react-router-dom";
import { CalendarDays, Download, Radar, Search, X } from "lucide-react";
import type { LayoutCtx } from "../../layout/Layout";
import { ProspectsTable } from "../../components/finder";
import { Dropdown } from "../../components/Dropdown";
import { dayKey, parseDayKey } from "../../components/Calendar";

const TAG_FILTERS = [
  { key: "all", label: "All" },
  { key: "email", label: "Email" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "both", label: "Both" },
  { key: "no-website", label: "No website" },
];

export default function FinderLeads() {
  const { prospects, searches, openAdd } = useOutletContext<LayoutCtx>();
  const [params, setParams] = useSearchParams();
  const searchId = params.get("search");
  const tag = params.get("tag") ?? "all";
  const date = params.get("date");
  const q = params.get("q") ?? "";
  const current = searches?.find((s) => s.id === searchId);

  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: k === "q" });
  };

  const needle = q.trim().toLowerCase();
  const shown = (prospects ?? []).filter((p) => {
    if (searchId && p.searchId !== searchId) return false;
    if (date && dayKey(p.createdAt) !== date) return false;
    if (tag === "both" && !(p.tags.includes("email") && p.tags.includes("whatsapp"))) return false;
    if (tag !== "all" && tag !== "both" && !p.tags.includes(tag)) return false;
    if (needle && ![p.name, p.category, p.phone, p.website, p.address, p.emails.join(" ")].join(" ").toLowerCase().includes(needle)) return false;
    return true;
  });

  const exportUrl = `/api/finder/export.csv?${new URLSearchParams({ ...(searchId ? { search: searchId } : {}), ...(tag !== "all" && tag !== "both" ? { tag } : {}) })}`;
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
          <a className="btn btn-white" href={exportUrl}><Download />Export CSV</a>
          <button className="btn btn-ink" onClick={openAdd}>Find leads</button>
        </div>
      </div>

      <div className="filter-bar">
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
        <span className="muted" style={{ marginLeft: "auto" }}>{shown.length} lead{shown.length === 1 ? "" : "s"}</span>
      </div>

      <div className="card card-lg">
        <ProspectsTable prospects={shown} searches={searches ?? []} />
      </div>
    </>
  );
}
