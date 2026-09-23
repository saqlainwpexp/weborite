import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Search } from "lucide-react";
import type { AdminClient } from "../../../../shared/types";
import { timeAgo, usePoll } from "../../lib/api";
import { money } from "../../components/charts";

const STAGES: { key: keyof AdminClient["stages"]; label: string; link: keyof AdminClient["links"] }[] = [
  { key: "lead", label: "Lead", link: "lead" },
  { key: "mockup", label: "Mockup", link: "lead" },
  { key: "build", label: "Website", link: "build" },
  { key: "wordpress", label: "WordPress", link: "wordpress" },
  { key: "live", label: "Launched", link: "seo" },
  { key: "maintenance", label: "Maintained", link: "care" },
];

export default function AdminClients() {
  const nav = useNavigate();
  const { data: rows } = usePoll<AdminClient[]>("/api/admin/clients", 20000);
  const { data: cur } = usePoll<{ currency: string }>("/api/settings", 60000);
  const [q, setQ] = useState("");
  const [paying, setPaying] = useState(false);
  const currency = cur?.currency ?? "USD";
  const shown = (rows ?? []).filter((r) => (!paying || r.paid > 0 || r.retainer > 0) && (!q || `${r.name} ${r.key}`.toLowerCase().includes(q.toLowerCase())));

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span>Super admin</span><span className="sep">/</span><span className="here">Clients</span></nav>
      <div className="title-row">
        <div><h1 className="page-title">Clients</h1><p className="muted" style={{ marginTop: 8 }}>Every business across mockups, builds, WordPress, SEO and maintenance, matched by domain</p></div>
      </div>
      <div className="filter-row">
        <div className="input-icon" style={{ maxWidth: 320, flex: 1 }}><Search /><input className="input" placeholder="Search clients" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search clients" /></div>
        <button type="button" className={`chip chip-btn${paying ? " on" : ""}`} aria-pressed={paying} onClick={() => setPaying(!paying)}>Paying clients</button>
      </div>
      <div className="card card-lg">
        {rows && !shown.length ? <div className="empty"><h4>No clients yet</h4><p>Leads, builds and sites show up here as they come in.</p></div> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Client</th>{STAGES.map((s) => <th key={s.key} className="hide-sm stage-th">{s.label}</th>)}<th style={{ textAlign: "right" }}>Paid</th><th className="hide-sm" style={{ textAlign: "right" }}>Owed</th><th className="hide-sm">Last activity</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.key}>
                  <td><div className="lead-cell"><span className="biz-mark" aria-hidden="true">{r.name.slice(0, 1).toUpperCase()}</span><div style={{ minWidth: 0 }}><b>{r.name}</b><span>{r.key}{r.retainer ? ` · ${money(r.retainer, currency)}/mo` : ""}</span></div></div></td>
                  {STAGES.map((s) => (
                    <td key={s.key} className="hide-sm stage-td">
                      {r.stages[s.key] ? <button type="button" className="stage-dot on" title={`${s.label}: open`} aria-label={`${s.label}: open`} onClick={() => r.links[s.link] && nav(r.links[s.link]!)}><Check /></button> : <span className="stage-dot" aria-label={`${s.label}: not yet`} />}
                    </td>
                  ))}
                  <td style={{ textAlign: "right" }}>{r.paid ? <b style={{ fontWeight: 500 }}>{money(r.paid, currency)}</b> : <span className="muted">–</span>}</td>
                  <td className="hide-sm" style={{ textAlign: "right" }}>{r.pending ? <span className="warn">{money(r.pending, currency)}</span> : <span className="muted">–</span>}</td>
                  <td className="hide-sm muted">{timeAgo(r.lastActivity)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
