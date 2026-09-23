import { useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import type { BenchmarkSet, Lead } from "../../../shared/types";
import { fileUrl, host, timeAgo } from "../lib/api";
import { StatusPill } from "./ui";

const SOURCE: Record<Lead["source"], string> = { elementor: "Elementor", meta: "Meta Ads", manual: "Manual", maps: "Google Maps" };

export function LeadsTable({ leads, benchmarks, compact = false }: { leads: Lead[]; benchmarks: BenchmarkSet[]; compact?: boolean }) {
  const nav = useNavigate();
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
            <th>Lead</th>
            {!compact && <th className="hide-sm">Source</th>}
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
            return (
              <tr key={l.id} className="row" onClick={() => nav(`/leads/${l.id}`)}>
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
