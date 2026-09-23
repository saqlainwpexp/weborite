import { useNavigate, useSearchParams } from "react-router-dom";
import { AlertTriangle, ArrowRight, Banknote, CircleDollarSign, Clock, CreditCard, Repeat, ShieldAlert, Users, XCircle } from "lucide-react";
import type { AdminOverview as Overview } from "../../../../shared/types";
import { timeAgo, usePoll } from "../../lib/api";
import { ColumnChart, Delta, Funnel, money } from "../../components/charts";

export const RANGES = [
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
  { key: "90", label: "90 days" },
  { key: "365", label: "12 months" },
  { key: "0", label: "All time" },
];

export const SERVICE_LABEL: Record<string, string> = { mockup: "Mockups", website: "Websites", wordpress: "WordPress", seo: "SEO", maintenance: "Maintenance", hosting: "Hosting", other: "Other" };
const SOURCE_LABEL: Record<string, string> = { elementor: "Website form", meta: "Meta ads", manual: "Added by you", maps: "Lead Finder" };

export default function AdminOverview() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const range = params.get("range") ?? "30";
  const { data: o, error } = usePoll<Overview>(`/api/admin/overview?range=${range}`, 15000);
  const rangeLabel = RANGES.find((r) => r.key === range)?.label.toLowerCase() ?? "";
  const $ = (n: number, compact = false) => money(n, o?.currency ?? "USD", compact);

  if (error && !o) return <div className="banner err"><XCircle />{error}</div>;
  const w = o?.work;
  const serviceMax = Math.max(1, ...(o?.revenue.byService.map((s) => s.paid) ?? [1]));

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span>Super admin</span><span className="sep">/</span><span className="here">Overview</span></nav>
      <div className="title-row">
        <h1 className="page-title">Business overview</h1>
        <div className="actions">
          <div className="seg" role="group" aria-label="Period">
            {RANGES.map((r) => <button key={r.key} type="button" className={range === r.key ? "on" : ""} aria-pressed={range === r.key} onClick={() => setParams({ range: r.key })}>{r.label}</button>)}
          </div>
          <button className="btn btn-ink" onClick={() => nav("/admin/revenue?new=1")}>Record payment <ArrowRight /></button>
        </div>
      </div>

      <div className="four">
        {[
          { label: range === "0" ? "Earned, all time" : `Earned, last ${rangeLabel}`, value: o ? $(o.revenue.paid) : "–", icon: <CircleDollarSign />, delta: o && <Delta now={o.revenue.paid} prev={o.revenue.paidPrev} /> },
          { label: "Waiting to be paid", value: o ? $(o.revenue.pending) : "–", icon: <Clock /> },
          { label: "Monthly retainers", value: o ? $(o.revenue.mrr) : "–", icon: <Repeat />, sub: o ? `${$(o.revenue.mrr * 12)} a year` : "" },
          { label: range === "0" ? "Leads, all time" : `Leads, last ${rangeLabel}`, value: o ? String(o.leads.total) : "–", icon: <Users />, delta: o && <Delta now={o.leads.total} prev={o.leads.prev} /> },
        ].map((k) => (
          <div key={k.label} className="card stat">
            <div className="top"><span className="tile">{k.icon}</span>{k.delta}</div>
            <div><b>{k.value}</b><span style={{ display: "block", marginTop: 8 }}>{k.label}</span>{k.sub && <small className="muted">{k.sub}</small>}</div>
          </div>
        ))}
      </div>

      <div className="grid-main">
        <div className="stack">
          <div className="card card-lg">
            <div className="card-head"><div><h3 className="card-title">Revenue</h3><p className="card-sub">Paid per month · {o ? `${$(o.revenue.allTime)} all time` : ""}</p></div>
              <button className="btn btn-chip btn-sm" onClick={() => nav("/admin/revenue")}>Payments</button></div>
            {o && (o.revenue.allTime > 0
              ? <ColumnChart data={o.revenue.months.map((m) => ({ label: m.label, value: m.paid }))} format={(n) => $(n, true)} label="Paid" />
              : <div className="empty" style={{ padding: "30px 12px" }}><p>No payments recorded yet. Record what clients pay, and set a monthly fee on maintained sites, to see earnings here.</p><button className="btn btn-ink btn-sm" style={{ marginTop: 12 }} onClick={() => nav("/admin/revenue?new=1")}><Banknote />Record a payment</button></div>)}
          </div>

          <div className="card card-lg">
            <div className="card-head"><div><h3 className="card-title">Leads</h3><p className="card-sub">New mockup leads per week</p></div></div>
            {o && <ColumnChart data={o.leads.weeks.map((x) => ({ label: x.label, value: x.leads }))} format={(n) => String(Math.round(n))} label="Leads" height={170} />}
            {o && (
              <dl className="fields">
                {o.leads.bySource.filter((s) => s.count).map((s) => <div key={s.source} className="field"><dt>{SOURCE_LABEL[s.source]}</dt><dd>{s.count}</dd></div>)}
                <div className="field"><dt>Mockups ready / needs review / failed</dt><dd>{o.leads.ready} / {o.leads.review} / {o.leads.failed}</dd></div>
                <div className="field"><dt>Lead Finder businesses found</dt><dd>{o.leads.prospects} · {o.leads.prospectsContactable} contactable · {o.leads.prospectsToMockup} sent to mockups</dd></div>
              </dl>
            )}
          </div>

          <div className="two">
            <div className="card">
              <h3 className="card-title">Client pipeline</h3>
              <p className="card-sub">How far each client has come, all time</p>
              {o && <Funnel stages={o.funnel} />}
              <button className="btn btn-chip btn-sm" style={{ marginTop: 14 }} onClick={() => nav("/admin/clients")}>All clients</button>
            </div>
            <div className="card">
              <h3 className="card-title">Work in progress</h3>
              <p className="card-sub">Across every workspace</p>
              {w && (
                <dl className="fields">
                  <div className="field"><dt>Builds</dt><dd>{w.buildsActive} running · {w.buildsReady} ready · {w.pagesBuilt} pages</dd></div>
                  <div className="field"><dt>WordPress</dt><dd>{w.conversionsDone} of {w.conversions} done · {w.wpPagesApproved} pages approved</dd></div>
                  <div className="field"><dt>Launch & SEO</dt><dd>{w.seoSites} sites · {w.seoSignedOff} signed off · {w.seoFixed} optimised</dd></div>
                  <div className="field"><dt>Maintenance</dt><dd>{w.careSites} sites · {w.careUpdates} updates applied{w.careWaiting ? ` · ${w.careWaiting} awaiting approval` : ""}</dd></div>
                  <div className="field"><dt>Average uptime</dt><dd>{w.uptime !== null ? `${w.uptime}%` : "–"}</dd></div>
                </dl>
              )}
            </div>
          </div>
        </div>

        <div className="stack side-col">
          <div className="card">
            <h3 className="card-title">Needs attention</h3>
            <p className="card-sub">{o ? (o.attention.length ? `${o.attention.length} item${o.attention.length === 1 ? "" : "s"}` : "Nothing waiting on you") : ""}</p>
            <div className="search-list">
              {o?.attention.map((a, i) => (
                <button key={i} type="button" className="search-row" style={{ gridTemplateColumns: "18px minmax(0,1fr)" }} onClick={() => nav(a.link)}>
                  {a.kind === "security" ? <ShieldAlert size={16} color="var(--red)" /> : a.kind === "failed" ? <XCircle size={16} color="var(--red)" /> : a.kind === "money" ? <CreditCard size={16} color="var(--amber)" /> : <AlertTriangle size={16} color="var(--amber)" />}
                  <span className="search-main"><b>{a.title}</b>{a.detail && <small>{a.detail}</small>}</span>
                </button>
              ))}
            </div>
          </div>

          {o && o.revenue.byService.length > 0 && (
            <div className="card">
              <h3 className="card-title">Earned by service</h3>
              <p className="card-sub">{range === "0" ? "All time" : `Last ${rangeLabel}`}</p>
              <ul className="hbar-list">
                {o.revenue.byService.map((s) => (
                  <li key={s.service}><span>{SERVICE_LABEL[s.service]}</span><span className="funnel-track"><span className="funnel-fill" style={{ width: `${(s.paid / serviceMax) * 100}%` }} /></span><b>{$(s.paid, true)}</b></li>
                ))}
              </ul>
            </div>
          )}

          {o && o.topClients.length > 0 && (
            <div className="card">
              <h3 className="card-title">Top clients</h3>
              <div className="search-list">
                {o.topClients.map((c) => (
                  <div key={c.key} className="search-row" style={{ gridTemplateColumns: "minmax(0,1fr) auto", cursor: "default" }}>
                    <span className="search-main"><b>{c.name}</b><small>{c.key}{c.retainer ? ` · ${$(c.retainer)}/mo` : ""}</small></span><b style={{ fontWeight: 500 }}>{$(c.paid)}</b>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card">
            <h3 className="card-title">Claude usage</h3>
            <dl className="fields">
              <div className="field"><dt>Jobs run</dt><dd>{o?.usage.jobs ?? "–"}</dd></div>
              <div className="field"><dt>API spend</dt><dd>{o ? `$${o.usage.apiCost.toFixed(2)}` : "–"} <span className="muted">(Session mode is on your plan)</span></dd></div>
            </dl>
          </div>

          <div className="card">
            <h3 className="card-title">Recent activity</h3>
            <ul className="activity">
              {o?.activity.map((e) => <li key={e.id}><b>{e.title}</b><span className="muted">{e.detail}</span><time className="muted">{timeAgo(e.at)}</time></li>)}
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}
