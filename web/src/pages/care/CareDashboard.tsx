import { useNavigate, useOutletContext } from "react-router-dom";
import { AlertTriangle, ArrowRight, CalendarClock, CheckCircle2, ClipboardCheck, Server, ShieldAlert, Wrench } from "lucide-react";
import type { LayoutCtx } from "../../layout/Layout";
import { host, timeAgo } from "../../lib/api";
import { CareTable, careState } from "./CareList";

const COVERS = [
  ["Updates, tested first", "Core, plugins, themes and translations go to a private staging copy on the same server (same PHP, MySQL and WordPress). Pages are compared screen by screen, forms submitted, and PHP errors checked before anything touches live."],
  ["Backup, then live", "UpdraftPlus runs right before the live update. Each plugin and theme also keeps a one-click rollback copy."],
  ["Vulnerabilities", "Every installed version is checked against WPVulnerability (CVE, Wordfence, Patchstack, WPScan data), plus closed and abandoned plugins and PHP end-of-life."],
  ["Security & integrity", "Hardening checks, admin accounts, PHP files in uploads, and core/plugin files compared with the official releases."],
  ["After the update", "The Launch & SEO checks run again: broken links, copy, forms present, speed and on-page SEO."],
  ["Health", "Uptime every 10 minutes, SSL and domain expiry, database clean-up, and a monthly report for the client."],
];

function nextRun(day: number) {
  if (!day) return null;
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), day, 6);
  if (d < now) d.setMonth(d.getMonth() + 1);
  return d;
}

export default function CareDashboard() {
  const { careSites, settings } = useOutletContext<LayoutCtx>();
  const nav = useNavigate();
  const all = careSites ?? [];
  const waiting = all.filter((s) => s.run?.status === "waiting");
  const attention = all.filter((s) => ["stopped", "vulnerable", "offline"].includes(careState(s).key) && s.run?.status !== "waiting");
  const stats = [
    { label: "Sites maintained", value: all.length, icon: <Server /> },
    { label: "Updates due", value: all.reduce((a, s) => a + (s.summary?.updates ?? 0), 0), icon: <Wrench /> },
    { label: "Known vulnerabilities", value: all.reduce((a, s) => a + (s.summary?.vulns ?? 0), 0), icon: <ShieldAlert /> },
    { label: "Awaiting approval", value: waiting.length, icon: <ClipboardCheck /> },
  ];
  const next = settings ? nextRun(settings.careDay) : null;
  const doneThisMonth = all.filter((s) => s.history[0]?.month === new Date().toISOString().slice(0, 7)).length;

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span>Maintenance</span><span className="sep">/</span><span className="here">Dashboard</span></nav>
      <div className="title-row">
        <h1 className="page-title">Website maintenance</h1>
        <div className="actions">
          <button className="btn btn-white" onClick={() => nav("/care/all")}>All sites</button>
          <button className="btn btn-ink" onClick={() => nav("/care/new")}>Add site <ArrowRight /></button>
        </div>
      </div>
      <div className="grid-main">
        <div className="stack">
          <div className="four">
            {stats.map((s) => (
              <div key={s.label} className="card stat">
                <div className="top"><span className="tile">{s.icon}</span></div>
                <div><b>{careSites ? s.value : "–"}</b><span style={{ display: "block", marginTop: 8 }}>{s.label}</span></div>
              </div>
            ))}
          </div>
          <div className="card card-lg">
            <div className="card-head" style={{ marginBottom: 20 }}>
              <div><h3 className="card-title">Portfolio</h3><p className="card-sub">{doneThisMonth} of {all.length} maintained this month</p></div>
              <button className="btn btn-chip btn-sm" onClick={() => nav("/care/all")}>View all</button>
            </div>
            <CareTable items={all.slice(0, 12)} compact />
          </div>
        </div>

        <div className="stack side-col">
          {waiting.length > 0 && (
            <div className="card">
              <h3 className="card-title">Awaiting your approval</h3>
              <p className="card-sub">Tested on staging, ready for live</p>
              <div className="search-list">
                {waiting.map((s) => (
                  <button key={s.id} type="button" className="search-row" style={{ gridTemplateColumns: "12px minmax(0,1fr) auto" }} onClick={() => nav(`/care/${s.id}`)}>
                    <span className="sq" style={{ background: s.run?.staging?.verdict === "pass" ? "var(--green)" : s.run?.staging?.verdict === "fail" ? "var(--red)" : "var(--amber)" }} />
                    <span className="search-main"><b>{s.name}</b><small>{s.run?.items.filter((i) => i.staging?.ok).length} updates · staging {s.run?.staging?.verdict === "pass" ? "passed" : s.run?.staging?.verdict === "fail" ? "failed" : "needs review"}</small></span>
                    <span className="btn btn-chip btn-xs">Review</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {attention.length > 0 && (
            <div className="card">
              <h3 className="card-title">Needs attention</h3>
              <div className="search-list">
                {attention.slice(0, 6).map((s) => {
                  const st = careState(s);
                  return (
                    <button key={s.id} type="button" className="search-row" style={{ gridTemplateColumns: "18px minmax(0,1fr)" }} onClick={() => nav(`/care/${s.id}`)}>
                      <AlertTriangle size={16} color={st.key === "offline" ? "var(--faint)" : "var(--red)"} />
                      <span className="search-main"><b>{s.name}</b><small>{st.label}{st.key === "vulnerable" ? ` · ${s.summary?.critical} high or critical` : st.key === "stopped" ? ` · ${s.run?.note ?? ""}` : ` · ${host(s.siteUrl)}`}</small></span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="card">
            <h3 className="card-title">Monthly check</h3>
            <p className="card-sub">{next ? <>Next: {next.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</> : "Switched off"}</p>
            <dl className="fields">
              <div className="field"><dt><CalendarClock size={15} /> Schedule</dt><dd>{settings?.careDay ? `Day ${settings.careDay} of every month` : "Manual only"}</dd></div>
              <div className="field"><dt><CheckCircle2 size={15} /> On that day</dt><dd>{settings?.careAutoStage ? "Scan, then test updates on staging and wait for you" : "Scan for updates and vulnerabilities"}</dd></div>
              <div className="field"><dt>Last check</dt><dd>{all.some((s) => s.lastScan) ? timeAgo(all.map((s) => s.lastScan ?? "").sort().pop()) : "Never"}</dd></div>
            </dl>
            <button className="btn btn-chip btn-sm" style={{ marginTop: 14 }} onClick={() => nav("/settings/maintenance")}>Change schedule</button>
          </div>
          <div className="card">
            <h3 className="card-title">What's covered</h3>
            <div className="phase-list">
              {COVERS.map(([t, d], i) => (
                <div key={t} className="phase-item"><span className="page-num">{i + 1}</span><div><b>{t}</b><p>{d}</p></div></div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
