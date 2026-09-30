import { useState, type ReactNode } from "react";
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import {
  AlertTriangle, CheckCircle2, Circle, Download, ExternalLink, FileSearch, Gauge, ImageIcon, Info, Loader2, Lock, Mail, Play, Plug, RefreshCw, Send, Sparkles, Trash2, XCircle,
} from "lucide-react";
import type { ChecklistItem, OnPageResult, PerfMetrics, PerfResult, QaResult, SeoRun, SeoSite } from "../../../../shared/types";
import type { LayoutCtx } from "../../layout/Layout";
import { api, host, timeAgo, usePoll } from "../../lib/api";
import { phaseState } from "./SeoList";
import SeoGoLive from "./SeoGoLive";

type Tab = "qa" | "perf" | "onpage" | "checklist" | "golive";
type Results = { qa: QaResult | null; perf: PerfResult | null; onpage: OnPageResult | null; checklist: ChecklistItem[] };

const kb = (b: number | null | undefined) => (b == null ? "–" : b > 1_000_000 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
const secs = (ms: number | undefined) => (ms == null ? "–" : `${(ms / 1000).toFixed(1)}s`);
const path = (u: string) => {
  try {
    return new URL(u).pathname || "/";
  } catch {
    return u;
  }
};
// Google's Core Web Vitals thresholds.
const grade = (metric: "lcp" | "cls" | "tbt" | "inp" | "score", v: number | undefined) => {
  if (v == null) return "";
  const t = { lcp: [2500, 4000], cls: [0.1, 0.25], tbt: [200, 600], inp: [200, 500], score: [-90, -50] }[metric];
  const x = metric === "score" ? -v : v;
  return x <= t[0] ? "good" : x <= t[1] ? "ok" : "bad";
};

function RunBar({ run, label, onRun, disabled, children }: { run?: SeoRun; label: string; onRun: () => void; disabled?: boolean; children?: ReactNode }) {
  const running = run?.status === "running";
  return (
    <div className="run-bar">
      <div>
        <b>{label}</b>
        <span className={run?.status === "failed" ? "bad" : "muted"}>
          {running ? run.note : run?.status === "done" ? `Last run ${timeAgo(run.finishedAt)}: ${run.note}` : run?.status === "failed" ? `Failed: ${run.note}` : "Not run yet"}
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {children}
        <button className="btn btn-ink btn-sm" onClick={onRun} disabled={running || disabled}>{running ? <Loader2 className="spin" /> : <Play />}{running ? "Running…" : run ? "Run again" : "Run"}</button>
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="empty" style={{ padding: "36px 12px" }}><p>{text}</p></div>;
}

export default function SeoDetail() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const { reloadAll } = useOutletContext<LayoutCtx>();
  const { data: s, error, reload } = usePoll<SeoSite & { busy: boolean }>(`/api/seo/${id}`, 3000);
  const { data: r, reload: reloadResults } = usePoll<Results>(`/api/seo/${id}/results`, 5000);
  const tab = (params.get("tab") as Tab) || "qa";
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [creds, setCreds] = useState({ wpUser: "", appPassword: "" });
  const [openSchema, setOpenSchema] = useState<string | null>(null);

  if (error && !s) return <div className="banner err"><XCircle />{error}</div>;
  if (!s) return <p className="muted">Loading…</p>;
  const st = phaseState(s);

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
    void reload();
    void reloadResults();
    reloadAll();
  }
  const run = (phase: string) => act(() => api(`/api/seo/${s.id}/run/${phase}`, { method: "POST" }));
  const propose = (kind: string) => act(() => api(`/api/seo/${s.id}/propose/${kind}`, { method: "POST" }), "Claude is drafting. It shows up here as it's ready.");
  const apply = (kinds: string[]) => act(() => api(`/api/seo/${s.id}/apply`, { method: "POST", json: { kinds } }), "Applying to WordPress…");
  const edit = (body: Record<string, string>) => api(`/api/seo/${s.id}/proposals`, { method: "PUT", json: body }).then(() => reloadResults());

  const qa = r?.qa;
  const perf = r?.perf;
  const onpage = r?.onpage;
  const checklist = r?.checklist ?? [];
  const failing = checklist.filter((c) => c.status === "fail").length;
  const tabs: { key: Tab; label: string; icon: ReactNode }[] = [
    { key: "qa", label: "1 · Post-launch QA", icon: s.qaSignedOff ? <CheckCircle2 className="ok" /> : s.runs.qa ? <AlertTriangle className="warn" /> : null },
    { key: "perf", label: "2 · Performance", icon: s.runs.perf?.status === "done" ? <CheckCircle2 className="ok" /> : null },
    { key: "onpage", label: "3 · On-page SEO", icon: !s.qaSignedOff ? <Lock className="muted" /> : s.runs.fixes?.status === "done" ? <CheckCircle2 className="ok" /> : null },
    { key: "checklist", label: `4 · Checklist${failing ? ` (${failing})` : ""}`, icon: null },
    { key: "golive", label: "5 · Go-live", icon: null },
  ];
  const canApply = s.qaSignedOff && s.connected?.ok;

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/seo/all">Launch & SEO</Link><span className="sep">/</span><span className="here">{s.name}</span></nav>
      <div className="title-row">
        <div>
          <h1 className="page-title">{s.name}</h1>
          <p className="muted" style={{ marginTop: 8 }}><a className="ext-link" href={s.siteUrl} target="_blank" rel="noreferrer">{host(s.siteUrl)}</a> · {s.pages.length ? `${s.pages.length} pages` : "pages found on first run"}{s.conversionId ? " · from WordPress conversion" : ""}</p>
        </div>
        <div className="actions">
          <span className={`status ${st.cls}`}><span className="dot" />{st.label}</span>
          <a className="btn btn-white" href={`/api/seo/${s.id}/plugin`}><Download />Connector plugin</a>
          <button className="btn btn-white" disabled={s.busy} onClick={() => act(() => api(`/api/seo/${s.id}/pages/discover`, { method: "POST" }), "Re-crawling the site and re-running QA.")}><RefreshCw />Re-crawl</button>
        </div>
      </div>
      {msg && <div className={`banner${msg.ok ? "" : " err"}`} style={msg.ok ? { background: "#eaf4ee", color: "#2f6f4a" } : undefined}>{msg.ok ? <CheckCircle2 /> : <XCircle />}{msg.text}</div>}

      <nav className="tabs" aria-label="Phases">
        {tabs.map((t) => (
          <button key={t.key} type="button" className={`tab tab-btn${tab === t.key ? " on" : ""}`} onClick={() => setParams({ tab: t.key })}>{t.icon}{t.label}</button>
        ))}
      </nav>

      <div className="grid-main">
        <div className="stack">
          {/* ---------- QA ---------- */}
          {tab === "qa" && (
            <>
              <div className="card card-lg stack" style={{ gap: 18 }}>
                <RunBar run={s.runs.qa} label="Post-launch QA" onRun={() => run("qa")} />
                <p className="muted" style={{ fontSize: 14 }}>Reads every page, proofreads the copy, compares phone numbers, emails, addresses and hours across pages, and checks every link. Forms are only submitted when you click “Test”.</p>
              </div>

              <div className="card card-lg">
                <div className="card-head">
                  <div><h3 className="card-title">Forms</h3><p className="card-sub">Test submissions use your QA email and are clearly labelled as tests</p></div>
                  <button className="btn btn-accent btn-sm" disabled={!qa?.forms.length || s.busy} onClick={() => {
                    if (confirm(`This sends ${qa!.forms.length} real test submission(s) to ${host(s.siteUrl)}. The site owner will receive them. Continue?`)) void act(() => api(`/api/seo/${s.id}/forms/test`, { method: "POST", json: { confirm: true } }), "Testing forms…");
                  }}><Send />Test all forms</button>
                </div>
                {qa?.forms.length ? (
                  <div className="table-wrap"><table className="table">
                    <thead><tr><th>Page</th><th>Form</th><th className="hide-sm">Fields</th><th>Result</th><th aria-label="Test" /></tr></thead>
                    <tbody>{qa.forms.map((f) => (
                      <tr key={f.page + f.index}>
                        <td className="nowrap"><a className="ext-link" href={f.page} target="_blank" rel="noreferrer">{path(f.page)}</a></td>
                        <td>{f.name}{f.captcha && <span className="chip" style={{ marginLeft: 6 }}>CAPTCHA</span>}</td>
                        <td className="hide-sm muted">{f.fields.map((x) => x.label || x.name).filter(Boolean).slice(0, 4).join(", ")}{f.fields.length > 4 ? "…" : ""}</td>
                        <td>{f.test ? <span className={f.test.ok ? "ok" : f.test.ok === false ? "bad" : "warn"} title={f.test.detail}>{f.test.ok ? "Works" : f.test.ok === false ? "Failed" : "Check by hand"}<small className="muted" style={{ display: "block", maxWidth: 260 }}>{f.test.detail.slice(0, 90)}</small></span> : <span className="muted">Not tested</span>}</td>
                        <td style={{ textAlign: "right" }}><button className="btn btn-chip btn-xs" disabled={s.busy} onClick={() => { if (confirm(`Send one test submission through this form on ${path(f.page)}?`)) void act(() => api(`/api/seo/${s.id}/forms/test`, { method: "POST", json: { confirm: true, page: f.page, index: f.index } })); }}>Test</button></td>
                      </tr>
                    ))}</tbody>
                  </table></div>
                ) : <Empty text={qa ? "No forms found on the site." : "Run QA to find the forms."} />}
              </div>

              <div className="card card-lg">
                <h3 className="card-title">Spelling & grammar</h3>
                <p className="card-sub">{qa ? `${qa.issues.length} issue${qa.issues.length === 1 ? "" : "s"} across ${s.pages.length} pages` : "Every page is proofread by Claude"}</p>
                {qa?.issues.length ? (
                  <ul className="issue-list">{qa.issues.map((i, n) => (
                    <li key={n}><span className={`chip issue-${i.type}`}>{i.type}</span><div><p><del>{i.text}</del> → <ins>{i.suggestion}</ins></p><small className="muted">{path(i.page)} · {i.reason}</small></div></li>
                  ))}</ul>
                ) : qa ? <Empty text="No mistakes found." /> : null}
              </div>

              <div className="card card-lg">
                <h3 className="card-title">Consistency</h3>
                <p className="card-sub">Contact details, names and hours compared across every page</p>
                {qa?.consistency.length ? (
                  <div className="cons-list">{qa.consistency.map((c, n) => (
                    <div key={n} className={`cons ${c.verdict}`}>
                      <div className="cons-head">{c.verdict === "consistent" ? <CheckCircle2 className="ok" /> : <AlertTriangle className="bad" />}<b>{c.kind}</b><span className="muted">{c.note}</span></div>
                      {c.verdict === "inconsistent" && <ul>{c.values.map((v) => <li key={v.value}><code>{v.value}</code> <span className="muted">on {v.pages.map(path).join(", ")}</span></li>)}</ul>}
                    </div>
                  ))}</div>
                ) : qa ? <Empty text="No contact details found to compare." /> : null}
              </div>

              <div className="card card-lg">
                <h3 className="card-title">Broken links</h3>
                {qa?.links.length ? (
                  <ul className="issue-list">{qa.links.map((l, n) => <li key={n}><span className="chip">{l.status}</span><div><p><a className="ext-link" href={l.href} target="_blank" rel="noreferrer">{l.href}</a></p><small className="muted">on {path(l.page)}</small></div></li>)}</ul>
                ) : <Empty text={qa ? "Every link works." : "Run QA to check links."} />}
              </div>

              <div className="approve-row" style={{ boxShadow: "var(--shadow-card)" }}>
                <div><b>{s.qaSignedOff ? "QA is complete" : "Done reviewing QA?"}</b><p className="muted" style={{ fontSize: 14 }}>{s.qaSignedOff ? "On-page SEO fixes are unlocked." : "Fix what needs fixing on the site, then sign off to unlock the on-page SEO phase."}</p></div>
                <button className={`btn btn-sm ${s.qaSignedOff ? "btn-chip" : "btn-accent"}`} disabled={!s.runs.qa} onClick={() => {
                  const open = checklist.filter((c) => c.group === "Post-launch QA" && c.status === "fail").length;
                  if (!s.qaSignedOff && open && !confirm(`${open} QA check(s) still fail. Sign off anyway?`)) return;
                  void act(() => api(`/api/seo/${s.id}/signoff`, { method: "POST", json: { value: !s.qaSignedOff } }));
                }}>{s.qaSignedOff ? "Reopen QA" : <><CheckCircle2 />Mark QA complete</>}</button>
              </div>
            </>
          )}

          {/* ---------- Performance ---------- */}
          {tab === "perf" && (
            <>
              <div className="card card-lg stack" style={{ gap: 18 }}>
                <RunBar run={s.runs.perf} label="Performance & page experience" onRun={() => run("perf")} />
                <p className="muted" style={{ fontSize: 14 }}>Lighthouse lab tests on mobile and desktop, real-user Core Web Vitals from Google (CrUX), page weight, and page experience. It takes about 40 seconds per page.</p>
                {perf && (
                  <div className="scores">
                    {(() => {
                      const m = perf.pages.map((p) => p.mobile).filter(Boolean) as PerfMetrics[];
                      const avg = (f: (x: PerfMetrics) => number) => (m.length ? m.reduce((a, x) => a + f(x), 0) / m.length : 0);
                      return [
                        ["Avg mobile score", Math.round(avg((x) => x.score)), grade("score", avg((x) => x.score))],
                        ["Avg LCP", secs(avg((x) => x.lcp)), grade("lcp", avg((x) => x.lcp))],
                        ["Avg CLS", avg((x) => x.cls).toFixed(3), grade("cls", avg((x) => x.cls))],
                        ["Avg page weight", kb(avg((x) => x.weight)), avg((x) => x.weight) > 2_000_000 ? "bad" : "good"],
                      ].map(([l, v, g]) => <div key={String(l)} className="score"><b className={String(g)}>{v}</b><span>{l}</span></div>);
                    })()}
                  </div>
                )}
              </div>
              <div className="card card-lg">
                <h3 className="card-title">Pages</h3>
                {perf ? (
                  <div className="table-wrap"><table className="table perf-table">
                    <thead><tr><th>Page</th><th>Mobile</th><th className="hide-sm">Desktop</th><th>LCP</th><th>CLS</th><th className="hide-sm">TBT</th><th className="hide-sm">Size</th><th className="hide-sm">Requests</th></tr></thead>
                    <tbody>{perf.pages.map((p) => (
                      <tr key={p.url}>
                        <td className="nowrap"><a className="ext-link" href={p.url} target="_blank" rel="noreferrer">{path(p.url)}</a></td>
                        <td><span className={`pill-num ${grade("score", p.mobile?.score)}`}>{p.mobile?.score ?? "–"}</span></td>
                        <td className="hide-sm"><span className={`pill-num ${grade("score", p.desktop?.score)}`}>{p.desktop?.score ?? "–"}</span></td>
                        <td className={grade("lcp", p.mobile?.lcp)}>{secs(p.mobile?.lcp)}</td>
                        <td className={grade("cls", p.mobile?.cls)}>{p.mobile?.cls ?? "–"}</td>
                        <td className={`hide-sm ${grade("tbt", p.mobile?.tbt)}`}>{p.mobile ? `${p.mobile.tbt}ms` : "–"}</td>
                        <td className="hide-sm">{kb(p.mobile?.weight)}</td>
                        <td className="hide-sm">{p.mobile?.requests ?? "–"}</td>
                      </tr>
                    ))}</tbody>
                  </table></div>
                ) : <Empty text="Run the performance audit to measure every page." />}
              </div>
              {perf && (
                <div className="two">
                  <div className="card">
                    <h3 className="card-title">Core Web Vitals</h3>
                    <p className="card-sub">Real users, mobile, 28 days (Google CrUX)</p>
                    <dl className="fields">{perf.pages.filter((p) => p.field).slice(0, 6).map((p) => (
                      <div key={p.url} className="field"><dt>{path(p.url)}</dt><dd>{p.field?.lcp != null ? (
                        <><span className={grade("lcp", p.field.lcp)}>LCP {secs(p.field.lcp)}</span> · <span className={grade("inp", p.field.inp)}>INP {p.field.inp ?? "–"}ms</span> · <span className={grade("cls", p.field.cls)}>CLS {p.field.cls ?? "–"}</span></>
                      ) : null}<small className="muted" style={{ display: "block" }}>{p.field?.source}</small></dd></div>
                    ))}</dl>
                  </div>
                  <div className="card">
                    <h3 className="card-title">Page experience</h3>
                    <p className="card-sub">HTTPS, mobile layout, console errors</p>
                    <dl className="fields">{perf.pages.map((p) => {
                      const probs = [!p.experience.https && "not HTTPS", !p.experience.viewport && "no viewport", ...p.experience.mobileIssues, p.experience.consoleErrors ? `${p.experience.consoleErrors} console errors` : ""].filter(Boolean);
                      return <div key={p.url} className="field"><dt>{path(p.url)}</dt><dd className={probs.length ? "bad" : "ok"}>{probs.length ? probs.join("; ") : "Good"}</dd></div>;
                    })}</dl>
                  </div>
                </div>
              )}
              <div className="card">
                <h3 className="card-title">GTmetrix</h3>
                {perf?.gtmetrix && "grade" in perf.gtmetrix ? (
                  <div className="gt">
                    <span className="gt-grade">{perf.gtmetrix.grade}</span>
                    <dl className="fields" style={{ flex: 1, marginTop: 0 }}>
                      <div className="field"><dt>Performance</dt><dd>{perf.gtmetrix.performance}%</dd></div>
                      <div className="field"><dt>Structure</dt><dd>{perf.gtmetrix.structure}%</dd></div>
                      <div className="field"><dt>Fully loaded</dt><dd>{secs(perf.gtmetrix.fullyLoaded)} · {kb(perf.gtmetrix.bytes)} · {perf.gtmetrix.requests} requests</dd></div>
                      <div className="field"><dt>Report</dt><dd><a className="ext-link" href={perf.gtmetrix.report} target="_blank" rel="noreferrer">Open on GTmetrix <ExternalLink size={12} /></a></dd></div>
                    </dl>
                  </div>
                ) : perf?.gtmetrix && "error" in perf.gtmetrix ? <p className="bad" style={{ fontSize: 14, marginTop: 10 }}>{perf.gtmetrix.error}</p>
                  : <p className="muted" style={{ fontSize: 14, marginTop: 10 }}>Add a free GTmetrix API key under <Link className="ext-link" to="/settings/integrations">Settings → Integrations</Link> to include a GTmetrix grade for the homepage.</p>}
              </div>
            </>
          )}

          {/* ---------- On-page SEO ---------- */}
          {tab === "onpage" && (
            <>
              {!s.qaSignedOff && <div className="banner"><Lock />Audits and drafts work now. Applying fixes to WordPress unlocks once post-launch QA is marked complete.</div>}
              <div className="card card-lg stack" style={{ gap: 18 }}>
                <RunBar run={s.runs.onpage} label="On-page SEO audit" onRun={() => run("onpage")}>
                  <button className="btn btn-white btn-sm" disabled={!canApply || s.busy} title={!s.connected?.ok ? "Connect WordPress first" : undefined} onClick={() => apply(["meta", "schema", "alt", "webp"])}><Sparkles />Apply everything</button>
                </RunBar>
                {s.runs.fixes && <p className={s.runs.fixes.status === "failed" ? "bad" : "muted"} style={{ fontSize: 14 }}>Fixes: {s.runs.fixes.status === "running" ? s.runs.fixes.note : s.runs.fixes.note}</p>}
                {onpage && (
                  <div className="site-checks">
                    {([["XML sitemap", Boolean(onpage.site.sitemap)], ["robots.txt", onpage.site.robotsTxt], ["http → https", onpage.site.httpsRedirect], ["Real 404", onpage.site.notFoundStatus === 404], ["Favicon", onpage.site.favicon]] as [string, boolean][]).map(([l, ok]) => (
                      <span key={l} className={`chip ${ok ? "ok" : "bad"}`}>{ok ? <CheckCircle2 /> : <XCircle />}{l}</span>
                    ))}
                  </div>
                )}
              </div>

              <div className="card card-lg">
                <div className="card-head">
                  <div><h3 className="card-title">Meta titles & descriptions</h3><p className="card-sub">Titles 30–60 characters, descriptions 70–160. Edit any draft before applying.</p></div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn btn-chip btn-sm" disabled={!onpage || s.busy} onClick={() => propose("meta")}><Sparkles />Draft with Claude</button>
                    <button className="btn btn-ink btn-sm" disabled={!canApply || s.busy || !onpage?.pages.some((p) => p.proposed && !p.proposed.applied)} onClick={() => apply(["meta"])}>Apply</button>
                  </div>
                </div>
                {onpage ? (
                  <div className="meta-list">{onpage.pages.map((p) => (
                    <div key={p.url} className="meta-row">
                      <div className="meta-head"><a className="ext-link" href={p.url} target="_blank" rel="noreferrer">{path(p.url)}</a>{p.proposed?.applied && <span className="status ready"><span className="dot" />Applied</span>}</div>
                      <div className="meta-now"><small className="muted">Now</small><p><b className={p.title.length < 30 || p.title.length > 60 ? "bad" : ""}>{p.title || "(no title)"}</b> <span className="muted">{p.title.length}</span></p><p className={p.description.length < 70 || p.description.length > 160 ? "bad" : "muted"}>{p.description || "(no meta description)"} <span className="muted">{p.description.length}</span></p></div>
                      {p.proposed && (
                        <div className="meta-new">
                          <small className="muted">Draft</small>
                          <input className="input" defaultValue={p.proposed.title} onBlur={(e) => e.target.value !== p.proposed!.title && edit({ url: p.url, title: e.target.value })} aria-label="Proposed title" />
                          <textarea className="input textarea" rows={2} defaultValue={p.proposed.description} onBlur={(e) => e.target.value !== p.proposed!.description && edit({ url: p.url, description: e.target.value })} aria-label="Proposed description" />
                          <small className="muted">{p.proposed.title.length} / {p.proposed.description.length} characters</small>
                        </div>
                      )}
                    </div>
                  ))}</div>
                ) : <Empty text="Run the audit to see every page's title and description." />}
              </div>

              <div className="card card-lg">
                <div className="card-head">
                  <div><h3 className="card-title">Images</h3><p className="card-sub">Alt text, weight and format. WebP conversion keeps the image in the media library and updates every page that uses it.</p></div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button className="btn btn-chip btn-sm" disabled={!onpage || s.busy} onClick={() => propose("alt")}><Sparkles />Draft alt text</button>
                    <button className="btn btn-ink btn-sm" disabled={!canApply || s.busy || !onpage?.images.some((i) => i.proposedAlt !== undefined && !i.altApplied)} onClick={() => apply(["alt"])}>Apply alt text</button>
                    <button className="btn btn-accent btn-sm" disabled={!canApply || s.busy || !onpage?.images.some((i) => ["jpg", "png"].includes(i.format) && i.webp?.status !== "done")} onClick={() => apply(["webp"])}><ImageIcon />Convert to WebP</button>
                  </div>
                </div>
                {onpage?.images.length ? (
                  <div className="img-list">{onpage.images.map((i) => (
                    <div key={i.src} className="img-row">
                      <img src={i.src} alt="" loading="lazy" />
                      <div className="img-info">
                        <div className="img-meta">
                          <span className={`chip ${["webp", "avif", "svg"].includes(i.format) || i.webp?.status === "done" ? "ok" : "bad"}`}>{i.webp?.status === "done" ? "webp" : i.format}</span>
                          <span className={`chip ${(i.webp?.after ?? i.bytes ?? 0) > 200_000 ? "bad" : ""}`}>{i.webp?.status === "done" ? `${kb(i.webp.before)} → ${kb(i.webp.after)}` : kb(i.bytes)}</span>
                          {i.width > i.renderedWidth * 2 && i.renderedWidth > 0 && <span className="chip bad">{i.width}px wide, shown at {i.renderedWidth}px</span>}
                          {i.webp?.status === "failed" && <span className="chip bad" title={i.webp.note}>WebP failed</span>}
                          <span className="muted" style={{ fontSize: 12 }}>{path(i.page)}</span>
                        </div>
                        <p className={i.alt === null ? "bad" : ""} style={{ fontSize: 14 }}>{i.alt === null ? "No alt attribute" : i.alt === "" ? "Empty alt (decorative)" : `Alt: ${i.alt}`}</p>
                        {i.proposedAlt !== undefined && (
                          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <input className="input" style={{ height: 38 }} defaultValue={i.proposedAlt} onBlur={(e) => e.target.value !== i.proposedAlt && edit({ src: i.src, alt: e.target.value })} aria-label="Proposed alt text" />
                            {i.altApplied && <CheckCircle2 className="ok" size={18} />}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}</div>
                ) : <Empty text={onpage ? "No images found." : "Run the audit to list every image."} />}
              </div>

              <div className="card card-lg">
                <div className="card-head">
                  <div><h3 className="card-title">Schema markup</h3><p className="card-sub">JSON-LD for every page and the content blocks on it. Checked against the page so nothing is invented.</p></div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn btn-chip btn-sm" disabled={!onpage || s.busy} onClick={() => propose("schema")}><Sparkles />Draft schema</button>
                    <button className="btn btn-ink btn-sm" disabled={!canApply || s.busy || !onpage?.pages.some((p) => p.schema?.jsonld && !p.schema.errors.length && !p.schema.applied)} onClick={() => apply(["schema"])}>Apply</button>
                  </div>
                </div>
                {onpage ? (
                  <div className="meta-list">{onpage.pages.map((p) => (
                    <div key={p.url} className="meta-row">
                      <div className="meta-head">
                        <a className="ext-link" href={p.url} target="_blank" rel="noreferrer">{path(p.url)}</a>
                        <span className="muted" style={{ fontSize: 13 }}>Now: {p.schemaTypes.join(", ") || "none"}</span>
                        {p.schema?.applied && <span className="status ready"><span className="dot" />Applied</span>}
                      </div>
                      {p.schema && (
                        <div>
                          <div className="tags">{p.schema.types.map((t) => <span key={t} className="tag tag-site">{t}</span>)}</div>
                          {p.schema.errors.map((e) => <p key={e} className="bad" style={{ fontSize: 13 }}>{e}</p>)}
                          <button className="link-btn" style={{ fontSize: 13, marginTop: 6 }} onClick={() => setOpenSchema(openSchema === p.url ? null : p.url)}>{openSchema === p.url ? "Hide JSON-LD" : "Show JSON-LD"}</button>
                          {openSchema === p.url && <pre className="json-pre">{JSON.stringify(p.schema.jsonld, null, 2)}</pre>}
                        </div>
                      )}
                    </div>
                  ))}</div>
                ) : <Empty text="Run the audit first." />}
              </div>
            </>
          )}

          {tab === "golive" && <SeoGoLive site={s} />}

          {/* ---------- Checklist ---------- */}
          {tab === "checklist" && (
            <div className="card card-lg">
              <div className="card-head">
                <div><h3 className="card-title">Launch checklist</h3><p className="card-sub">{checklist.filter((c) => c.status === "pass" || c.status === "done").length} of {checklist.length} complete</p></div>
                <Link className="btn btn-chip btn-sm" to="/seo/checklist">Edit template</Link>
              </div>
              {[...new Set(checklist.map((c) => c.group))].map((g) => (
                <div key={g} className="check-group">
                  <h5>{g}</h5>
                  {checklist.filter((c) => c.group === g).map((c) => (
                    <div key={c.id} className={`check-item ${c.status}`}>
                      <span className="check-ico">{c.status === "pass" || c.status === "done" ? <CheckCircle2 className="ok" /> : c.status === "fail" ? <XCircle className="bad" /> : <Circle className="muted" />}</span>
                      <div><b>{c.label}</b>{c.detail && <small className="muted">{c.detail}</small>}</div>
                      {c.status !== "pass" && (
                        <button className="btn btn-chip btn-xs" onClick={() => act(() => api(`/api/seo/${s.id}/checklist/${c.id}`, { method: "PUT", json: { status: c.status === "done" ? "todo" : "done" } }))}>{c.status === "done" ? "Undo" : "Mark done"}</button>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ---------- Right column ---------- */}
        <div className="stack side-col">
          <div className="card">
            <h3 className="card-title">Phases</h3>
            <div className="steps">
              {([["qa", "Post-launch QA", <FileSearch key="a" />], ["forms", "Form tests", <Mail key="b" />], ["perf", "Performance", <Gauge key="c" />], ["onpage", "On-page audit & drafts", <Info key="d" />], ["fixes", "Fixes applied", <Sparkles key="e" />]] as [keyof SeoSite["runs"], string, ReactNode][]).map(([k, l]) => {
                const rr = s.runs[k];
                return (
                  <div key={k} className={`step${rr?.status === "running" ? " running" : ""}`} title={rr?.note}>
                    <div><b>{l}</b><span>{rr ? (rr.status === "running" ? rr.note : `${timeAgo(rr.finishedAt)} · ${rr.note ?? ""}`) : "Not run"}</span></div>
                    <span className="ico">{rr?.status === "done" ? <CheckCircle2 className="ok" /> : rr?.status === "running" ? <Loader2 className="spin" style={{ color: "var(--accent)" }} /> : rr?.status === "failed" ? <XCircle className="bad" /> : <Circle className="muted" style={{ color: "var(--faint)" }} />}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card">
            <h3 className="card-title">WordPress</h3>
            <p className="card-sub">Needed only to apply fixes</p>
            <dl className="fields">
              <div className="field"><dt>Status</dt><dd>{s.connected?.ok ? <span className="ok">Connected</span> : <span className="muted">Not connected</span>}</dd></div>
              {s.connected?.ok && <div className="field"><dt>SEO plugin</dt><dd>{s.connected.seoPlugin === "yoast" ? "Yoast (meta written there)" : s.connected.seoPlugin === "rankmath" ? "Rank Math (meta written there)" : "None: the connector prints meta and schema"}</dd></div>}
            </dl>
            {!s.conversionId && !s.connected?.ok && (
              <div className="stack" style={{ gap: 10, marginTop: 14 }}>
                <input className="input" placeholder={s.wpUser || "WordPress username"} value={creds.wpUser} onChange={(e) => setCreds({ ...creds, wpUser: e.target.value })} autoComplete="off" aria-label="WordPress username" />
                <input className="input mono" type="password" placeholder={s.appPasswordSet ? "•••••••• saved" : "Application Password"} value={creds.appPassword} onChange={(e) => setCreds({ ...creds, appPassword: e.target.value })} autoComplete="off" aria-label="Application Password" />
              </div>
            )}
            <button className="btn btn-chip btn-sm" style={{ marginTop: 14 }} onClick={() => act(async () => {
              if (creds.wpUser || creds.appPassword) await api(`/api/seo/${s.id}/credentials`, { method: "PUT", json: creds });
              await api(`/api/seo/${s.id}/test`, { method: "POST" });
            }, "Connected.")}><Plug />Test connection</button>
          </div>

          <div className="card">
            <h3 className="card-title">Pages</h3>
            <p className="card-sub">{s.pages.length ? `${s.pages.length} found (sitemap + links)` : "Found on the first run"}</p>
            <ul className="ref-list" style={{ marginTop: 10 }}>
              {s.pages.slice(0, 30).map((p) => <li key={p.url}><a href={p.url} target="_blank" rel="noreferrer"><span className="ref-name">{path(p.url)}</span><span className="ref-host">{p.title}</span></a></li>)}
            </ul>
          </div>

          <button className="btn btn-ghost" style={{ alignSelf: "flex-start" }} disabled={s.busy} onClick={() => { if (confirm(`Remove ${s.name} from the dashboard? Nothing on the live site changes.`)) void act(async () => { await api(`/api/seo/${s.id}`, { method: "DELETE" }); nav("/seo/all"); }); }}><Trash2 />Remove site</button>
        </div>
      </div>
    </>
  );
}
