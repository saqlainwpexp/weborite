import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import {
  Activity, AlertTriangle, ArchiveRestore, CheckCircle2, Circle, Database, Download, ExternalLink, FileText, Globe, KeyRound, Loader2, Lock, Mail,
  Play, Plug, RefreshCw, RotateCcw, ScanSearch, Server, ShieldAlert, ShieldCheck, Trash2, Wrench, XCircle,
} from "lucide-react";
import type { CareHardening, CareHealth, CareIntegrity, CareIntel, CarePageCheck, CareRun, CareStagingInfo, CareStatus, CareStep, CareTestReport, CareUpdateItem } from "../../../../shared/types";
import type { LayoutCtx } from "../../layout/Layout";
import { api, host, timeAgo, usePoll } from "../../lib/api";
import { careState, type CareView } from "./CareList";

type Tab = "maintenance" | "updates" | "security" | "health" | "reports";
type Data = {
  status: CareStatus | null;
  intel: CareIntel | null;
  health: CareHealth | null;
  integrity: CareIntegrity | null;
  hardening: CareHardening | null;
  staging: CareStagingInfo | null;
  env: { matches: boolean; diffs: string[] } | null;
  uptime: [number, number, number][];
};

const STEPS: { key: CareStep; label: string; hint: string }[] = [
  { key: "scan", label: "Scan live", hint: "Versions, updates, vulnerabilities" },
  { key: "clone", label: "Clone to staging", hint: "Same server, same PHP and MySQL" },
  { key: "baseline", label: "Baseline", hint: "Screenshots and form tests before" },
  { key: "update-staging", label: "Update staging", hint: "One by one, rolled back if it breaks" },
  { key: "test-staging", label: "Test staging", hint: "Pages, forms, PHP errors, plugins" },
  { key: "approve", label: "Your approval", hint: "Pick what goes live" },
  { key: "backup", label: "Backup live", hint: "UpdraftPlus, or your confirmation" },
  { key: "update-live", label: "Update live", hint: "Same order, rollback copy per item" },
  { key: "verify-live", label: "Verify live", hint: "Screenshots, errors, SEO checks" },
];

const bytes = (b: number | null | undefined) => (b == null ? "–" : b > 1_073_741_824 ? `${(b / 1_073_741_824).toFixed(1)} GB` : b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
const date = (x?: string | number | null) => (x ? new Date(typeof x === "number" ? x * 1000 : x).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "–");
const itemKey = (i: CareUpdateItem) => `${i.kind}:${i.id}`;
const SEV = { critical: "bad", high: "bad", medium: "warn", low: "", unknown: "" } as const;

function Verdict({ report }: { report: CareTestReport }) {
  const v = report.verdict;
  return (
    <div className={`verdict ${v}`}>
      {v === "pass" ? <CheckCircle2 /> : v === "review" ? <AlertTriangle /> : <XCircle />}
      <div>
        <b>{report.target === "staging" ? "Staging" : "Live"} {v === "pass" ? "passed every check" : v === "review" ? "needs a look" : "found problems"}</b>
        {report.reasons.length > 0 && <ul>{report.reasons.slice(0, 8).map((r) => <li key={r}>{r}</li>)}</ul>}
      </div>
    </div>
  );
}

function PageShots({ siteId, run, pages, threshold }: { siteId: string; run: CareRun; pages: CarePageCheck[]; threshold: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const src = (f?: string) => (f ? `/api/care/${siteId}/shot/${run.id}/${f}` : "");
  return (
    <div className="shot-list">
      {pages.map((p) => {
        const bad = p.fatal || (p.status >= 400 && (p.beforeStatus ?? 200) < 400);
        const look = p.diff !== null && p.diff > threshold;
        return (
          <div key={p.path} className="shot-row">
            <button type="button" className="shot-head" onClick={() => setOpen(open === p.path ? null : p.path)} aria-expanded={open === p.path}>
              <span className="shot-path">{p.path}</span>
              <span className={`pill-num ${bad ? "bad" : p.status < 400 ? "good" : "ok"}`}>{p.status || "–"}</span>
              <span className={`pill-num ${look ? "ok" : "good"}`} title="Pixels changed">{p.diff === null ? "–" : `${p.diff}%`}</span>
              {p.consoleErrors > (p.beforeConsole ?? 0) && <span className="pill-num ok" title="New JavaScript errors">JS +{p.consoleErrors - (p.beforeConsole ?? 0)}</span>}
              {p.fatal && <span className="pill-num bad">PHP error</span>}
            </button>
            {open === p.path && (
              <div className="shot-grid">
                {[["Before", p.before], ["After", p.after], ["Difference", p.diffImage]].map(([l, f]) => (
                  <figure key={l}>
                    <figcaption>{l}</figcaption>
                    {f ? <a href={src(f)} target="_blank" rel="noreferrer"><img src={src(f)} alt={`${l}: ${p.path}`} loading="lazy" /></a> : <div className="shot-missing">No screenshot</div>}
                  </figure>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ItemsTable({ run, pick, setPick, onRollback }: { run: CareRun; pick?: Set<string>; setPick?: (s: Set<string>) => void; onRollback?: (i: CareUpdateItem) => void }) {
  const choosing = Boolean(pick && setPick);
  return (
    <div className="table-wrap">
      <table className="table items-table">
        <thead><tr>{choosing && <th aria-label="Apply" />}<th>Update</th><th>Version</th><th>Staging</th><th>Live</th></tr></thead>
        <tbody>
          {run.items.map((i) => {
            const k = itemKey(i);
            const can = i.staging?.ok;
            return (
              <tr key={k} className={!i.selected && !choosing ? "dim" : ""}>
                {choosing && <td><input type="checkbox" aria-label={`Apply ${i.name} to live`} disabled={!can} checked={pick!.has(k)} onChange={(e) => { const n = new Set(pick); if (e.target.checked) n.add(k); else n.delete(k); setPick!(n); }} /></td>}
                <td>
                  <b className="item-name">{i.name}</b>
                  <span className="item-tags">
                    <span className="tag">{i.kind}</span>
                    {i.security && <span className="tag sec">security fix</span>}
                    {i.premium && <span className="tag">premium</span>}
                  </span>
                  {i.blocked && <small className="warn">{i.blocked}</small>}
                </td>
                <td className="mono-num">{i.kind === "translations" ? i.from : <>{i.from} → <b>{i.to}</b></>}</td>
                <td>{i.staging ? <span className={i.staging.ok ? "good" : "bad"} title={i.staging.note}>{i.staging.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />} {i.staging.ok ? "Passed" : i.staging.rolledBack ? "Rolled back" : "Failed"}</span> : <span className="muted">{i.selected ? "–" : "Skipped"}</span>}{i.staging && !i.staging.ok && <small className="muted">{i.staging.note}</small>}</td>
                <td>
                  {i.live ? <span className={i.live.ok && !i.live.rolledBack ? "good" : "bad"} title={i.live.note}>{i.live.ok && !i.live.rolledBack ? <CheckCircle2 size={16} /> : <XCircle size={16} />} {i.live.rolledBack ? "Rolled back" : i.live.ok ? "Updated" : "Failed"}</span> : <span className="muted">–</span>}
                  {i.live && !i.live.ok && <small className="muted">{i.live.note}</small>}
                  {onRollback && i.live?.ok && !i.live.rolledBack && (i.kind === "plugin" || i.kind === "theme") && <button className="btn btn-chip btn-xs" style={{ marginTop: 6 }} onClick={() => onRollback(i)}><RotateCcw />Roll back</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Report({ siteId, run, report, threshold }: { siteId: string; run: CareRun; report: CareTestReport; threshold: number }) {
  return (
    <div className="stack" style={{ gap: 18 }}>
      <Verdict report={report} />
      <div>
        <h4 className="sub-title">Pages ({report.pages.length})</h4>
        <PageShots siteId={siteId} run={run} pages={report.pages} threshold={threshold} />
      </div>
      {report.forms.length > 0 && (
        <div>
          <h4 className="sub-title">Forms on staging <span className="muted">(emails captured, nothing sent)</span></h4>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Form</th><th>Before</th><th>After</th><th>Email generated</th></tr></thead>
            <tbody>
              {report.forms.map((f) => (
                <tr key={`${f.page}-${f.index}`}>
                  <td><b>{f.name}</b><small className="muted" style={{ display: "block" }}>{f.page}</small></td>
                  {[f.before, f.after, f.mail].map((v, n) => <td key={n}>{v === true ? <CheckCircle2 size={16} className="good" /> : v === false ? <XCircle size={16} className="bad" /> : <span className="muted">–</span>}</td>)}
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}
      <dl className="fields">
        <div className="field"><dt>PHP errors logged</dt><dd>{report.errors.fatal ? <span className="bad">{report.errors.fatal} fatal</span> : <span className="good">No fatal errors</span>}{report.errors.warning ? <span className="muted"> · {report.errors.warning} warnings</span> : ""}</dd></div>
        <div className="field"><dt>Plugins still active</dt><dd>{report.deactivated.length ? <span className="bad">Deactivated: {report.deactivated.join(", ")}</span> : <span className="good">All</span>}</dd></div>
        {report.env && <div className="field"><dt>Same as live</dt><dd>{report.env.matches ? <span className="good">WordPress, PHP, database, server and plugins match</span> : <span className="warn">{report.env.diffs.join("; ")}</span>}</dd></div>}
      </dl>
      {report.errors.lines.length > 0 && <pre className="json-pre">{report.errors.lines.join("\n")}</pre>}
    </div>
  );
}

function Uptime({ samples }: { samples: [number, number, number][] }) {
  const days: { day: string; up: number; n: number }[] = [];
  for (let d = 13; d >= 0; d--) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - d);
    const from = start.getTime() / 1000;
    const inDay = samples.filter((s) => s[0] >= from && s[0] < from + 86400);
    days.push({ day: start.toLocaleDateString("en-GB", { day: "numeric", month: "short" }), up: inDay.filter((s) => s[1] > 0 && s[1] < 500).length, n: inDay.length });
  }
  return (
    <div className="uptime" role="img" aria-label="Uptime over the last 14 days">
      {days.map((d) => {
        const pct = d.n ? d.up / d.n : null;
        return <span key={d.day} className={pct === null ? "none" : pct === 1 ? "up" : pct > 0.97 ? "part" : "down"} title={`${d.day}: ${pct === null ? "no checks" : `${Math.round(pct * 1000) / 10}% of ${d.n} checks`}`} />;
      })}
    </div>
  );
}

export default function CareDetail() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const { reloadAll, settings } = useOutletContext<LayoutCtx>();
  const { data: s, error, reload } = usePoll<CareView>(`/api/care/${id}`, 3000);
  const { data: d, reload: reloadData } = usePoll<Data>(`/api/care/${id}/data`, 8000);
  const tab = (params.get("tab") as Tab) || "maintenance";
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [creds, setCreds] = useState({ wpUser: "", appPassword: "" });
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [backupOk, setBackupOk] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const runId = s?.run?.id;
  const waiting = s?.run?.step === "approve";
  useEffect(() => {
    if (waiting && s?.run) setPick(new Set(s.run.items.filter((i) => i.staging?.ok).map(itemKey)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, waiting]);

  if (error && !s) return <div className="banner err"><XCircle />{error}</div>;
  if (!s) return <p className="muted">Loading…</p>;
  const st = careState(s);
  const status = d?.status;
  const intel = d?.intel;
  const health = d?.health;
  const run = s.run;
  const active = run && ["running", "waiting", "failed"].includes(run.status) ? run : null;
  const threshold = settings?.careDiffThreshold ?? 1;
  const updraft = status?.backup.updraft;

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
    void reload();
    void reloadData();
    reloadAll();
  }
  const post = (p: string, json?: unknown) => api(`/api/care/${s.id}${p}`, { method: "POST", json: json ?? {} });

  const tabs: { key: Tab; label: string; icon?: ReactNode }[] = [
    { key: "maintenance", label: "Maintenance", icon: waiting ? <AlertTriangle className="warn" /> : run?.status === "running" ? <Loader2 className="spin" /> : null },
    { key: "updates", label: `Updates${s.summary?.updates ? ` (${s.summary.updates})` : ""}` },
    { key: "security", label: `Security${s.summary?.vulns ? ` (${s.summary.vulns})` : ""}`, icon: s.summary?.critical ? <ShieldAlert className="bad" /> : null },
    { key: "health", label: "Health" },
    { key: "reports", label: "Reports" },
  ];
  const stepIndex = run ? STEPS.findIndex((x) => x.key === run.step) : -1;
  const pendingCount = s.summary?.updates ?? 0;
  const connected = s.connected?.ok;

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/care/all">Maintenance</Link><span className="sep">/</span><span className="here">{s.name}</span></nav>
      <div className="title-row">
        <div>
          <h1 className="page-title">{s.name}</h1>
          <p className="muted" style={{ marginTop: 8 }}><a className="ext-link" href={s.siteUrl} target="_blank" rel="noreferrer">{host(s.siteUrl)}</a>{s.client ? ` · ${s.client}` : ""}{status ? ` · WordPress ${status.core.version} · PHP ${status.env.php}` : ""}</p>
        </div>
        <div className="actions">
          <span className={`status ${st.cls}`}><span className="dot" />{st.label}</span>
          <button className="btn btn-white" disabled={s.busy || !s.appPasswordSet} onClick={() => act(() => post("/scan"))}><RefreshCw />Scan now</button>
          <button className="btn btn-ink" disabled={s.busy || Boolean(active && active.status !== "failed") || !connected} onClick={() => act(() => post("/run"), "Maintenance started: updates are tested on staging first.")}><Play />Run maintenance</button>
        </div>
      </div>
      {msg && <div className={`banner${msg.ok ? "" : " err"}`} style={msg.ok ? { background: "#eaf4ee", color: "#2f6f4a" } : undefined}>{msg.ok ? <CheckCircle2 /> : <XCircle />}{msg.text}</div>}
      {s.job?.status === "running" && <div className="banner" style={{ background: "var(--accent-softer)", color: "var(--text)" }}><Loader2 className="spin" />{s.job.note}</div>}
      {s.job?.status === "failed" && s.job.kind !== "run" && <div className="banner err"><XCircle />{s.job.note}</div>}

      {!connected && (
        <div className="card card-lg setup-card">
          <h3 className="card-title">Connect this site</h3>
          <ol className="setup-steps">
            <li><div><b>Download the Studio Connector</b><p>It's generated for this site. If the site already has it from a conversion or SEO audit, this is the updated version with maintenance.</p></div><a className="btn btn-accent btn-sm" href={`/api/care/${s.id}/plugin`}><Download />Connector plugin</a></li>
            <li><div><b>Install it on {host(s.siteUrl)}</b><p>Plugins → Add New → Upload Plugin → choose the zip → Activate. To update an older copy, WordPress offers "Replace current with uploaded".</p></div></li>
            <li><div><b>Connect and scan</b><p>{s.connected?.error ?? "Checks versions, updates, vulnerabilities, SSL and domain. Nothing changes on the site."}</p></div><button className="btn btn-ink btn-sm" disabled={s.busy} onClick={() => act(() => post("/scan"))}><Plug />Connect & scan</button></li>
          </ol>
        </div>
      )}

      <nav className="tabs" aria-label="Sections">
        {tabs.map((t) => <button key={t.key} type="button" className={`tab tab-btn${tab === t.key ? " on" : ""}`} onClick={() => setParams({ tab: t.key })}>{t.icon}{t.label}</button>)}
      </nav>

      <div className="grid-main">
        <div className="stack">
          {/* ---------- Maintenance ---------- */}
          {tab === "maintenance" && (
            <>
              {!active && (
                <div className="card card-lg">
                  <div className="run-bar">
                    <div>
                      <b>{pendingCount ? `${pendingCount} update${pendingCount === 1 ? "" : "s"} available` : status ? "Everything is up to date" : "Not scanned yet"}</b>
                      <span className="muted">{run?.status === "done" ? `Last maintenance ${timeAgo(run.finishedAt)}: ${run.note}` : run?.status === "cancelled" ? "The last run was cancelled" : "Updates are installed on a private staging copy first. Live only changes after you approve."}</span>
                    </div>
                    <button className="btn btn-ink btn-sm" disabled={s.busy || !connected} onClick={() => act(() => post("/run"), "Maintenance started.")}><Play />Run maintenance</button>
                  </div>
                  {run?.status === "done" && run.items.length > 0 && <div style={{ marginTop: 18 }}><ItemsTable run={run} onRollback={(i) => { if (confirm(`Put ${i.name} back to ${i.from} on the LIVE site, using the copy taken right before the update?`)) void act(() => post("/rollback", { confirm: true, kind: i.kind, id: i.id }), "Rolling back…"); }} /></div>}
                </div>
              )}

              {active && (
                <div className="card card-lg">
                  <div className="card-head">
                    <div><h3 className="card-title">{run!.month} maintenance</h3><p className="card-sub">{active.status === "failed" ? <span className="bad">Stopped: {active.note}</span> : active.note}</p></div>
                    <div style={{ display: "flex", gap: 8 }}>
                      {active.status === "failed" && <button className="btn btn-ink btn-sm" disabled={s.busy} onClick={() => act(() => post("/run/resume"), "Resuming…")}><Play />Resume</button>}
                      {active.status !== "running" && <button className="btn btn-chip btn-sm" onClick={() => { if (confirm("Cancel this maintenance run? Nothing more changes on the site, and the staging copy is removed.")) void act(() => post("/run/cancel")); }}>Cancel run</button>}
                    </div>
                  </div>
                  {active.items.length > 0 && <div style={{ marginTop: 18 }}><ItemsTable run={active} pick={waiting ? pick : undefined} setPick={waiting ? setPick : undefined} /></div>}
                </div>
              )}

              {active?.staging && (
                <div className="card card-lg">
                  <div className="card-head"><div><h3 className="card-title">Staging test</h3><p className="card-sub">Same server, same PHP and database. Tested {timeAgo(active.staging.at)}</p></div></div>
                  <div style={{ marginTop: 16 }}><Report siteId={s.id} run={active} report={active.staging} threshold={threshold} /></div>
                </div>
              )}

              {waiting && active && (
                <div className="card card-lg approve-card">
                  <h3 className="card-title">Update the live site</h3>
                  <p className="card-sub">{pick.size} of {active.items.filter((i) => i.staging?.ok).length} updates that passed on staging are selected. They're applied in the same order, one at a time, with the home page checked after each.</p>
                  {updraft ? (
                    <p className="approve-note"><ArchiveRestore size={16} />A full UpdraftPlus backup runs first. Live is only touched once it finishes without errors.</p>
                  ) : (
                    <label className="approve-note check"><input type="checkbox" checked={backupOk} onChange={(e) => setBackupOk(e.target.checked)} />
                      <span>UpdraftPlus isn't on this site{status?.backup.plugins.length ? ` (found: ${status.backup.plugins.join(", ")})` : ""}. I've taken a current backup and can restore it.</span></label>
                  )}
                  <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
                    <button className="btn btn-ink" disabled={!pick.size || (!updraft && !backupOk) || s.busy} onClick={() => {
                      if (confirm(`Update ${pick.size} item(s) on the LIVE site ${host(s.siteUrl)} now?`)) void act(() => post("/run/approve", { items: [...pick], backupConfirmed: backupOk }), "Approved. Backing up, then updating live.");
                    }}><Play />Approve & update live</button>
                    {d?.staging?.status === "ready" && <a className="btn btn-white" href={`${d.staging.url}/?studio_stg=${d.staging.token}`} target="_blank" rel="noreferrer"><ExternalLink />Open staging</a>}
                  </div>
                </div>
              )}

              {active?.live && (
                <div className="card card-lg">
                  <div className="card-head"><div><h3 className="card-title">Live check</h3><p className="card-sub">After the update, {timeAgo(active.live.at)}</p></div></div>
                  <div style={{ marginTop: 16 }}><Report siteId={s.id} run={active} report={active.live} threshold={threshold} /></div>
                </div>
              )}
              {run?.status === "done" && run.live && (
                <div className="card card-lg">
                  <div className="card-head"><div><h3 className="card-title">Live check</h3><p className="card-sub">{date(run.live.at)}</p></div>
                    <a className="btn btn-chip btn-sm" href={`/api/care/${s.id}/report?run=${run.id}`}><FileText />Client report</a></div>
                  <div style={{ marginTop: 16 }}><Report siteId={s.id} run={run} report={run.live} threshold={threshold} /></div>
                </div>
              )}

              {run && run.log.length > 0 && (
                <div className="card">
                  <button type="button" className="log-toggle" onClick={() => setShowLog(!showLog)} aria-expanded={showLog}><b>Activity log</b><span className="muted">{run.log.length} entries</span></button>
                  {showLog && <ol className="run-log">{[...run.log].reverse().map((l, i) => <li key={i}><time>{new Date(l.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</time>{l.text}</li>)}</ol>}
                </div>
              )}
            </>
          )}

          {/* ---------- Updates & versions ---------- */}
          {tab === "updates" && (
            <div className="card card-lg">
              <div className="card-head"><div><h3 className="card-title">Installed software</h3><p className="card-sub">{status ? `Checked ${timeAgo(new Date(status.at * 1000).toISOString())}` : "Scan the site to list it"}</p></div></div>
              {status && (
                <div className="table-wrap" style={{ marginTop: 16 }}><table className="table">
                  <thead><tr><th>Name</th><th>Installed</th><th>Available</th><th className="hide-sm">Source</th><th className="hide-sm">Auto-update</th></tr></thead>
                  <tbody>
                    <tr><td><b>WordPress</b> <span className="tag">core</span></td><td>{status.core.version}</td><td>{status.core.update ? <b className="warn">{status.core.update}</b> : <span className="good">Latest</span>}</td><td className="hide-sm">wordpress.org</td><td className="hide-sm muted">{d?.status?.security.find((c) => c.id === "core-auto")?.status === "ok" ? "Security releases" : "Off"}</td></tr>
                    {status.plugins.map((p) => {
                      const v = intel?.vulns.filter((x) => x.slug === p.slug) ?? [];
                      return (
                        <tr key={p.file} className={p.active ? "" : "dim"}>
                          <td><b>{p.name}</b> {!p.active && <span className="tag">inactive</span>} {v.length > 0 && <span className="tag sec">{v.length} vulnerabilit{v.length === 1 ? "y" : "ies"}</span>}</td>
                          <td>{p.version}</td>
                          <td>{p.update ? <b className={v.length ? "bad" : "warn"}>{p.update}</b> : <span className="good">Latest</span>}{p.update && !p.package && <small className="warn" style={{ display: "block" }}>Licence needed</small>}</td>
                          <td className="hide-sm">{p.wporg ? "wordpress.org" : "Premium / other"}</td>
                          <td className="hide-sm muted">{p.auto_update ? "On" : "Off"}</td>
                        </tr>
                      );
                    })}
                    {status.themes.map((t) => (
                      <tr key={t.stylesheet} className={t.active || t.parent ? "" : "dim"}>
                        <td><b>{t.name}</b> <span className="tag">{t.active ? "active theme" : t.parent ? "parent theme" : "theme"}</span></td>
                        <td>{t.version}</td>
                        <td>{t.update ? <b className="warn">{t.update}</b> : <span className="good">Latest</span>}</td>
                        <td className="hide-sm">Theme</td><td className="hide-sm muted">–</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </div>
          )}

          {/* ---------- Security ---------- */}
          {tab === "security" && (
            <>
              <div className="card card-lg">
                <div className="card-head"><div><h3 className="card-title">Known vulnerabilities</h3><p className="card-sub">WPVulnerability database · {intel ? `checked ${timeAgo(intel.at)}` : "scan to check"}</p></div></div>
                {intel && !intel.vulns.length && <p className="good" style={{ marginTop: 14 }}><CheckCircle2 size={16} /> None for the installed versions of WordPress, PHP, plugins and themes.</p>}
                {intel && intel.vulns.length > 0 && (
                  <ul className="issue-list">
                    {intel.vulns.map((v, i) => (
                      <li key={i}>
                        <span className={`chip ${SEV[v.severity]}`}>{v.severity}{v.score ? ` ${v.score}` : ""}</span>
                        <div>
                          <b style={{ fontWeight: 500 }}>{v.name} {v.installed}</b>
                          <p>{v.title}</p>
                          <p className="muted" style={{ fontSize: 13 }}>{v.fixedIn ? <>Fixed in {v.fixedIn}: <b>update</b></> : v.component === "php" ? "Upgrade PHP with the host" : "No fix released yet: consider deactivating or replacing it"}{v.cve ? ` · ${v.cve}` : ""}{v.link && <> · <a className="ext-link" href={v.link} target="_blank" rel="noreferrer">Details</a></>}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {intel && (intel.abandoned.length > 0 || intel.php.status !== "supported") && (
                <div className="card card-lg">
                  <h3 className="card-title">End of life</h3>
                  <ul className="issue-list">
                    {intel.php.status !== "supported" && <li><span className={`chip ${intel.php.status === "eol" ? "bad" : "warn"}`}>PHP</span><div><b style={{ fontWeight: 500 }}>PHP {intel.php.version}</b><p>{intel.php.status === "eol" ? `No security fixes since ${date(intel.php.endsAt)}. Ask the host to move the site to PHP 8.3 or newer (test on staging first).` : intel.php.status === "security" ? `Security fixes only, until ${date(intel.php.endsAt)}.` : "Unknown version"}</p></div></li>}
                    {intel.abandoned.map((a) => <li key={a.slug}><span className={`chip ${a.reason === "closed" ? "bad" : "warn"}`}>{a.reason}</span><div><b style={{ fontWeight: 500 }}>{a.name}</b><p>{a.detail} Plan a replacement.</p></div></li>)}
                  </ul>
                </div>
              )}
              <div className="card card-lg">
                <h3 className="card-title">Hardening</h3>
                {status ? (
                  <div className="check-group">
                    {[...status.security, ...(health ? [{ id: "listing", label: "No open directory listings", status: health.dirListing ? "warn" : "ok", detail: health.dirListing ? "/wp-content/uploads/ lists its files" : "" } as const] : [])].map((c) => (
                      <div key={c.id} className="check-item">
                        <span className="check-ico">{c.status === "ok" ? <CheckCircle2 className="ok" /> : c.status === "fail" ? <XCircle className="bad" /> : c.status === "warn" ? <AlertTriangle className="warn" /> : <Circle className="muted" />}</span>
                        <div><b>{c.label}</b>{c.detail && <small className="muted">{c.detail}</small>}</div>
                        <span />
                      </div>
                    ))}
                  </div>
                ) : <p className="muted" style={{ marginTop: 12 }}>Scan the site first.</p>}
              </div>
              <div className="card card-lg">
                <div className="run-bar">
                  <div><b><ShieldCheck size={17} /> Wordfence &amp; login protection</b><span className="muted">{d?.hardening ? `Configured ${timeAgo(d.hardening.at)}` : "Installs Wordfence from wordpress.org, turns on brute-force protection and login rules, and switches XML-RPC off."}</span></div>
                  <button className="btn btn-ink btn-sm" disabled={s.busy || !connected} onClick={() => { if (confirm("Install and configure Wordfence on the live site? This installs the free Wordfence plugin from wordpress.org, locks out repeated failed logins, blocks breached and weak admin passwords, and switches XML-RPC off. Application Passwords stay on, since the studio uses one.")) void act(() => post("/harden", { confirm: true }), "Securing the site…"); }}><ShieldCheck />{d?.hardening ? "Apply again" : "Install & configure Wordfence"}</button>
                </div>
                {d?.hardening && (
                  <div className="check-group">
                    <div className="check-item">
                      <span className="check-ico"><CheckCircle2 className="ok" /></span>
                      <div><b>Wordfence {d.hardening.version}</b><small className="muted">{d.hardening.installed ? "Installed and activated by the studio" : "Already installed"}</small></div>
                      <span />
                    </div>
                    {d.hardening.settings.map((x) => (
                      <div key={x.key} className="check-item">
                        <span className="check-ico">{x.ok ? <CheckCircle2 className="ok" /> : <AlertTriangle className="warn" />}</span>
                        <div><b>{x.label}</b>{!x.ok && <small className="muted">Wordfence didn't accept this setting. Check it under Wordfence → All Options.</small>}</div>
                        <span />
                      </div>
                    ))}
                    <div className="check-item">
                      <span className="check-ico">{d.hardening.xmlrpc_off ? <CheckCircle2 className="ok" /> : <AlertTriangle className="warn" />}</span>
                      <div><b>XML-RPC switched off</b></div>
                      <span />
                    </div>
                    {d.hardening.notes.map((n) => <p key={n} className="muted" style={{ fontSize: 13, margin: "10px 0 0" }}>{n}</p>)}
                  </div>
                )}
              </div>
              <div className="card card-lg">
                <div className="run-bar">
                  <div><b>File integrity</b><span className="muted">{d?.integrity ? `Checked ${timeAgo(d.integrity.at)}` : "Compares every WordPress core file and wordpress.org plugin file with the official release. Finds injected code."}</span></div>
                  <button className="btn btn-ink btn-sm" disabled={s.busy || !connected} onClick={() => act(() => post("/integrity"))}><ScanSearch />{d?.integrity ? "Check again" : "Check files"}</button>
                </div>
                {d?.integrity && (() => {
                  const g = d.integrity;
                  const plug = g.plugins.filter((p) => p.modified.length || p.added.length);
                  const clean = !g.core.modified.length && !g.core.unknown.length && !g.core.missing.length && !plug.length && !g.uploads_php.length;
                  return clean ? <p className="good" style={{ marginTop: 14 }}><CheckCircle2 size={16} /> Core ({g.core.checked ? "verified" : "not verifiable"}) and {g.plugins.length} wordpress.org plugins match the official files. No PHP in uploads.</p> : (
                    <ul className="issue-list">
                      {g.core.modified.length > 0 && <li><span className="chip bad">core</span><div><b style={{ fontWeight: 500 }}>Modified core files</b><p className="mono-num">{g.core.modified.slice(0, 12).join(", ")}</p></div></li>}
                      {g.core.unknown.length > 0 && <li><span className="chip bad">core</span><div><b style={{ fontWeight: 500 }}>Unexpected PHP files in core folders</b><p className="mono-num">{g.core.unknown.slice(0, 12).join(", ")}</p></div></li>}
                      {g.core.missing.length > 0 && <li><span className="chip warn">core</span><div><b style={{ fontWeight: 500 }}>Missing core files</b><p className="mono-num">{g.core.missing.slice(0, 12).join(", ")}</p></div></li>}
                      {plug.map((p) => <li key={p.slug}><span className="chip bad">plugin</span><div><b style={{ fontWeight: 500 }}>{p.name}</b><p className="mono-num">{[...p.modified.map((f) => `modified: ${f}`), ...p.added.map((f) => `added: ${f}`)].slice(0, 10).join(", ")}</p></div></li>)}
                      {g.uploads_php.length > 0 && <li><span className="chip bad">uploads</span><div><b style={{ fontWeight: 500 }}>PHP files in uploads</b><p className="mono-num">{g.uploads_php.slice(0, 12).join(", ")}</p></div></li>}
                    </ul>
                  );
                })()}
              </div>
            </>
          )}

          {/* ---------- Health ---------- */}
          {tab === "health" && (
            <>
              <div className="card card-lg">
                <div className="card-head"><div><h3 className="card-title">Uptime</h3><p className="card-sub">Checked every 10 minutes while this app is running</p></div>
                  <b className="big-num">{health?.uptime.days30 != null ? `${health.uptime.days30}%` : "–"}</b></div>
                <Uptime samples={d?.uptime ?? []} />
                <dl className="fields">
                  <div className="field"><dt>Average response</dt><dd>{health?.uptime.avgMs != null ? `${health.uptime.avgMs} ms` : "–"}</dd></div>
                  <div className="field"><dt>Last outage</dt><dd>{health?.uptime.lastDown ? timeAgo(health.uptime.lastDown) : "None recorded"}</dd></div>
                </dl>
              </div>
              <div className="two">
                <div className="card">
                  <h3 className="card-title"><Lock size={18} /> SSL & domain</h3>
                  <dl className="fields">
                    <div className="field"><dt>Certificate</dt><dd>{health?.ssl ? <span className={health.ssl.daysLeft < 14 ? "bad" : "good"}>{health.ssl.daysLeft} days left</span> : "–"}</dd></div>
                    <div className="field"><dt>Issuer</dt><dd>{health?.ssl?.issuer ?? "–"}</dd></div>
                    <div className="field"><dt>Domain renews</dt><dd>{health?.domain ? <span className={health.domain.daysLeft < 30 ? "bad" : ""}>{date(health.domain.expires)} ({health.domain.daysLeft} days)</span> : "Not published by the registry"}</dd></div>
                    <div className="field"><dt>Registrar</dt><dd>{health?.domain?.registrar || "–"}</dd></div>
                  </dl>
                </div>
                <div className="card">
                  <h3 className="card-title"><ArchiveRestore size={18} /> Backups</h3>
                  <dl className="fields">
                    <div className="field"><dt>Plugin</dt><dd>{status?.backup.plugins.join(", ") || <span className="bad">None found</span>}</dd></div>
                    <div className="field"><dt>Last UpdraftPlus backup</dt><dd>{status?.backup.last ? <span className={Date.now() / 1000 - status.backup.last > 8 * 86400 ? "warn" : "good"}>{date(status.backup.last)}{status.backup.last_ok ? "" : " (with errors)"}</span> : "–"}</dd></div>
                    <div className="field"><dt>Rollback copies</dt><dd>{status ? Object.keys(status.rollbacks).length : "–"}</dd></div>
                  </dl>
                </div>
              </div>
              <div className="card card-lg">
                <div className="run-bar">
                  <div><b><Database size={17} /> Database</b><span className="muted">{status ? `${bytes(status.db.size)} · autoloaded options ${bytes(status.db.autoload)}` : "–"}</span></div>
                  <button className="btn btn-chip btn-sm" disabled={s.busy || !connected} onClick={() => { if (confirm("Clean the live database? Removes expired transients, spam and trashed comments older than 30 days, old auto-drafts, and revisions beyond the newest 10 per page. This can't be undone without a backup.")) void act(() => post("/tidy", { confirm: true }), "Cleaning up…"); }}><Wrench />Clean up</button>
                </div>
                {status && (
                  <dl className="fields">
                    <div className="field"><dt>Revisions</dt><dd>{status.db.revisions}</dd></div>
                    <div className="field"><dt>Expired transients</dt><dd>{status.db.transients}</dd></div>
                    <div className="field"><dt>Spam and trashed comments</dt><dd>{status.db.spam_comments}</dd></div>
                    <div className="field"><dt>Auto-drafts / trashed posts</dt><dd>{status.db.auto_drafts} / {status.db.trash}</dd></div>
                  </dl>
                )}
              </div>
              {status && (
                <div className="card card-lg">
                  <h3 className="card-title"><Server size={18} /> Environment</h3>
                  <dl className="fields">
                    <div className="field"><dt>PHP</dt><dd>{status.env.php} ({status.env.sapi}) · memory {status.env.memory_limit} · max execution {status.env.max_exec}s</dd></div>
                    <div className="field"><dt>Database</dt><dd>{status.env.db}</dd></div>
                    <div className="field"><dt>Web server</dt><dd>{status.env.server || "–"}</dd></div>
                    <div className="field"><dt>File writes</dt><dd>{status.env.fs_method === "direct" ? <span className="good">Direct (updates work)</span> : <span className="bad">{status.env.fs_method}: updates need FS_METHOD direct</span>}</dd></div>
                    <div className="field"><dt>Disk free</dt><dd>{bytes(status.env.disk_free)}</dd></div>
                    <div className="field"><dt>Object cache</dt><dd>{status.env.object_cache ? "Yes (skipped on staging)" : "No"}</dd></div>
                    <div className="field"><dt>WP-Cron</dt><dd>{status.env.cron ? "WordPress" : "Server cron"}</dd></div>
                    <div className="field"><dt>PHP extensions</dt><dd className="muted">{status.env.extensions.length} loaded</dd></div>
                  </dl>
                </div>
              )}
            </>
          )}

          {/* ---------- Reports ---------- */}
          {tab === "reports" && (
            <div className="card card-lg">
              <div className="card-head">
                <div><h3 className="card-title">Monthly reports</h3><p className="card-sub">A branded PDF for {s.client || "the client"}: updates, security fixes, uptime, speed and health</p></div>
                <a className="btn btn-ink btn-sm" href={`/api/care/${s.id}/report`}><Download />Current report</a>
              </div>
              {s.history.length ? (
                <div className="table-wrap" style={{ marginTop: 16 }}><table className="table">
                  <thead><tr><th>Month</th><th>Updates</th><th>Result</th><th className="hide-sm">Finished</th><th aria-label="Download" /></tr></thead>
                  <tbody>
                    {s.history.map((h) => (
                      <tr key={h.id}>
                        <td><b>{new Date(h.month + "-01").toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</b><small className="muted" style={{ display: "block" }}>{h.note}</small></td>
                        <td>{h.updated}</td>
                        <td><span className={`status ${h.verdict === "pass" ? "ready" : h.verdict === "review" ? "needs_review" : "failed"}`}><span className="dot" />{h.verdict === "pass" ? "Passed" : h.verdict === "review" ? "Reviewed" : "Issues"}</span></td>
                        <td className="hide-sm muted">{date(h.finishedAt)}</td>
                        <td style={{ textAlign: "right" }}><a className="btn btn-chip btn-xs" href={`/api/care/${s.id}/report?run=${h.id}`}><FileText />PDF</a></td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              ) : <div className="empty" style={{ padding: "36px 12px" }}><p>Reports appear here after each maintenance run.</p></div>}
            </div>
          )}
        </div>

        {/* ---------- Right column ---------- */}
        <div className="stack side-col">
          <div className="card">
            <h3 className="card-title">This month</h3>
            <div className="steps">
              {STEPS.map((x, i) => {
                const doneStep = run && (run.status === "done" ? true : i < stepIndex);
                const current = run && i === stepIndex && run.status !== "done";
                return (
                  <div key={x.key} className={`step${current && run!.status === "running" ? " running" : ""}`} title={x.hint}>
                    <div><b>{x.label}</b><span>{current ? (run!.status === "failed" ? `Stopped: ${run!.note}` : run!.note) : x.hint}</span></div>
                    <span className="ico">{doneStep ? <CheckCircle2 className="ok" /> : current ? (run!.status === "running" ? <Loader2 className="spin" style={{ color: "var(--accent)" }} /> : run!.status === "failed" ? <XCircle className="bad" /> : <AlertTriangle className="warn" />) : <Circle className="muted" style={{ color: "var(--faint)" }} />}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card">
            <h3 className="card-title">Connection</h3>
            <dl className="fields">
              <div className="field"><dt>Status</dt><dd>{connected ? <span className="good">Connected</span> : <span className="muted">{s.connected ? "Failed" : "Not connected"}</span>}</dd></div>
              {s.connected?.plugin && <div className="field"><dt>Connector</dt><dd>{s.connected.plugin}</dd></div>}
              <div className="field"><dt>Last scan</dt><dd>{s.lastScan ? timeAgo(s.lastScan) : "Never"}</dd></div>
            </dl>
            <div className="stack" style={{ gap: 10, marginTop: 14 }}>
              <input className="input" placeholder={s.wpUser || "Administrator username"} value={creds.wpUser} onChange={(e) => setCreds({ ...creds, wpUser: e.target.value })} autoComplete="off" aria-label="WordPress username" />
              <input className="input mono" type="password" placeholder={s.appPasswordSet ? "•••••••• saved" : "Application Password"} value={creds.appPassword} onChange={(e) => setCreds({ ...creds, appPassword: e.target.value })} autoComplete="off" aria-label="Application Password" />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              <button className="btn btn-chip btn-sm" disabled={s.busy} onClick={() => act(async () => {
                if (creds.wpUser || creds.appPassword) await api(`/api/care/${s.id}`, { method: "PUT", json: creds });
                setCreds({ wpUser: "", appPassword: "" });
                await post("/scan");
              })}><KeyRound />Save & scan</button>
              <a className="btn btn-chip btn-sm" href={`/api/care/${s.id}/plugin`}><Download />Connector</a>
            </div>
          </div>

          <div className="card">
            <h3 className="card-title">Staging copy</h3>
            <p className="card-sub">{d?.staging && d.staging.status !== "none" ? (d.staging.status === "ready" ? `Ready since ${timeAgo(new Date((d.staging.ready_at ?? 0) * 1000).toISOString())}` : d.staging.status === "failed" ? `Failed: ${d.staging.error}` : `Being created (${d.staging.status})`) : "Created fresh from live for every run"}</p>
            {d?.env && <p className={d.env.matches ? "good" : "warn"} style={{ fontSize: 14, marginTop: 10 }}>{d.env.matches ? <><CheckCircle2 size={15} /> Matches live</> : <><AlertTriangle size={15} /> {d.env.diffs.length} difference{d.env.diffs.length === 1 ? "" : "s"} from live</>}</p>}
            {d?.staging?.status === "ready" && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                <a className="btn btn-chip btn-sm" href={`${d.staging.url}/?studio_stg=${d.staging.token}`} target="_blank" rel="noreferrer"><Globe />Open</a>
                <button className="btn btn-chip btn-sm" disabled={s.busy || run?.status === "running"} onClick={() => { if (confirm("Delete the staging copy (its folder and database tables)? Live isn't touched.")) void act(() => post("/staging/delete"), "Staging copy removed."); }}><Trash2 />Delete</button>
              </div>
            )}
            <ul className="mini-list">
              <li><Mail size={14} />Emails are captured, not sent</li>
              <li><ShieldCheck size={14} />Private and not indexed</li>
              <li><Activity size={14} />Outgoing webhooks and payments blocked</li>
            </ul>
          </div>

          <button className="btn btn-ghost" style={{ alignSelf: "flex-start" }} disabled={s.busy} onClick={() => { if (confirm(`Remove ${s.name} from maintenance? Its staging copy is deleted; the live site doesn't change.`)) void act(async () => { await api(`/api/care/${s.id}`, { method: "DELETE" }); nav("/care/all"); }); }}><Trash2 />Remove site</button>
        </div>
      </div>
    </>
  );
}
