import { useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import type { BenchmarkSet, Lead } from "../../../shared/types";
import { fileUrl, host, timeAgo } from "../lib/api";
import { StatusPill } from "./ui";

const SOURCE: Record<Lead["source"], string> = { elementor: "Elementor", meta: "Meta Ads", manual: "Manual", maps: "Google Maps" };
const TEMP_LABEL = { hot: "Hot", warm: "Warm", cold: "Cold" } as const;

function TempPill({ temp, score }: { temp?: Lead["temp"]; score?: number }) {
  if (!temp) return <span className="muted">—</span>;
  return <span className={`temp-pill ${temp}`} title={typeof score === "number" ? `Lead score ${score}/100` : undefined}>{TEMP_LABEL[temp]}</span>;
}

export function LeadsTable({
  leads, benchmarks, compact = false, selectable = false, selected, onToggle, onToggleAll,
}: {
  leads: Lead[];
  benchmarks: BenchmarkSet[];
  compact?: boolean;
  selectable?: boolean;
  selected?: Set<string>;
  onToggle?: (id: string, on: boolean) => void;
  onToggleAll?: (on: boolean) => void;
}) {
  const nav = useNavigate();
  const picks = selectable ? leads.filter((l) => selected?.has(l.id)).length : 0;
  const allOn = selectable && leads.length > 0 && picks === leads.length;
  if (!leads.length) {
    return (
      <div className="empty">
        <h4>No leads yet</h4>
        <p>Leads from your Elementor and Meta forms appear here. You can also add one with Create.</p>
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {selectable && (
              <th className="col-check">
                <input type="checkbox" aria-label="Select all" checked={allOn} ref={(el) => { if (el) el.indeterminate = picks > 0 && !allOn; }} onChange={(e) => onToggleAll?.(e.target.checked)} />
              </th>
            )}
            <th>Lead</th>
            {!compact && <th className="hide-sm">Source</th>}
            <th className="hide-sm">Score</th>
            <th className="hide-sm">Vertical</th>
            <th>Status</th>
            <th className="hide-sm">Received</th>
            <th aria-label="Open" />
          </tr>
        </thead>
        <tbody>
          {leads.map((l) => {
            const v = benchmarks.find((b) => b.vertical === l.vertical);
            const done = l.steps.find((s) => s.key === "capture")?.status === "done";
            const on = selected?.has(l.id) ?? false;
            return (
              <tr key={l.id} className={`row${on ? " picked" : ""}`} onClick={() => nav(`/leads/${l.id}`)}>
                {selectable && (
                  <td className="col-check" onClick={(e) => { e.stopPropagation(); onToggle?.(l.id, !on); }}>
                    <input type="checkbox" aria-label={`Select ${l.business || host(l.url)}`} checked={on} readOnly tabIndex={0} onKeyDown={(e) => { if (e.key === " ") { e.preventDefault(); onToggle?.(l.id, !on); } }} />
                  </td>
                )}
                <td>
                  <div className="lead-cell">
                    <span className="thumb" style={done ? { backgroundImage: `url(${fileUrl(l.id, "desktop-fold.jpg")})` } : undefined} />
                    <div style={{ minWidth: 0 }}>
                      <b>{l.business || host(l.url)}</b>
                      <span>{host(l.url)}{l.name ? ` · ${l.name}` : ""}</span>
                    </div>
                  </div>
                </td>
                {!compact && <td className="hide-sm"><span className="chip">{SOURCE[l.source]}</span></td>}
                <td className="hide-sm"><TempPill temp={l.temp} score={l.score} /></td>
                <td className="hide-sm">{v ? <span className="vchip"><i style={{ background: v.color }} />{v.label}</span> : <span className="muted">—</span>}</td>
                <td><StatusPill status={l.status} /></td>
                <td className="hide-sm muted">{timeAgo(l.createdAt)}</td>
                <td style={{ textAlign: "right" }}>
                  <span className="btn btn-sm btn-icon btn-chip" aria-hidden="true"><ArrowRight /></span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
