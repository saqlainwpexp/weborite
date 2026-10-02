import { useOutletContext, useSearchParams } from "react-router-dom";
import { ArrowRight, CalendarDays, Flame, Layers, X } from "lucide-react";
import type { LayoutCtx } from "../layout/Layout";
import { LeadsTable } from "../components/LeadsTable";
import { Dropdown } from "../components/Dropdown";
import { dayKey, parseDayKey } from "../components/Calendar";

const FILTERS = [
  { key: "all", label: "All statuses" },
  { key: "ready", label: "Ready" },
  { key: "active", label: "In progress" },
  { key: "review", label: "Needs review" },
];

export default function Leads() {
  const { leads, benchmarks, openAdd } = useOutletContext<LayoutCtx>();
  const [params, setParams] = useSearchParams();
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

      <div className="card card-lg">
        {date && !shown.length ? (
          <div className="empty">
            <h4>No leads on {dateLabel}</h4>
            <p>Pick another day from the calendar in the top bar, or clear the filter.</p>
          </div>
        ) : (
          <LeadsTable leads={shown} benchmarks={benchmarks ?? []} />
        )}
      </div>
    </>
  );
}
