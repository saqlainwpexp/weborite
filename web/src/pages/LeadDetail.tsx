import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import {
  AlertTriangle, ArrowRight, ArrowUpRight, Blocks, CheckCircle2, ChevronDown, Clock, Download, ExternalLink, FileOutput,
  Image as ImageIcon, Info, Layers, Monitor, RefreshCw, Smartphone, StickyNote, Trash2, Users, XCircle,
} from "lucide-react";
import { STEPS, type LeadDetail as Detail, type StepKey } from "../../../shared/types";
import type { LayoutCtx } from "../layout/Layout";
import { api, duration, fileUrl, host, shortDate, timeAgo, usePoll } from "../lib/api";
import { EventIcon, StatusPill, StepIcon } from "../components/ui";

type View = "desktop" | "mobile";

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function Viewport({ view, children }: { view: View; children: (scale: number) => React.ReactNode }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  return (
    <div className={`viewport ${view}`}>
      <div className="scroller" ref={ref}>{w > 0 && children(w / 1440)}</div>
    </div>
  );
}

function Empty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return <div className="empty-pane"><div>{icon}<p>{text}</p></div></div>;
}

export default function LeadDetail() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { events, reloadAll } = useOutletContext<LayoutCtx>();
  const { data: lead, error, reload } = usePoll<Detail>(`/api/leads/${id}`, 3000);
  const [view, setView] = useState<View>("desktop");
  const [live, setLive] = useState(false);
  const [rerunOpen, setRerunOpen] = useState(false);
  const [bust, setBust] = useState(0);

  // Refresh the mockup iframe when a new version lands.
  const genDone = lead?.steps.find((s) => s.key === "generate")?.finishedAt;
  useEffect(() => setBust(Date.now()), [genDone]);

  if (error && !lead) return <div className="banner err"><XCircle />{error}</div>;
  if (!lead) return <p className="muted">Loading…</p>;

  const name = lead.business || host(lead.url);
  const stepMeta = (k: StepKey) => STEPS.find((s) => s.key === k)!;
  const doneSteps = lead.steps.filter((s) => s.status === "done");
  const lastDone = [...doneSteps].sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))[0];
  const next = lead.steps.find((s) => s.status !== "done");
  const captured = lead.steps[0].status === "done";
  const brand = lead.diagnosis?.brand;
  const swatches = brand ? [brand.primary, brand.secondary, brand.accent, brand.text].filter(Boolean) as string[] : [];
  const leadEvents = (events ?? []).filter((e) => e.leadId === lead.id || e.kind === "lead").slice(0, 3);
  const busy = lead.status === "running" || lead.status === "queued";

  async function run(from?: StepKey) {
    setRerunOpen(false);
    await api(`/api/leads/${lead!.id}/run`, { method: "POST", json: from ? { from } : {} });
    void reload();
    reloadAll();
  }

  async function remove() {
    if (!confirm(`Delete ${name} and all its files?`)) return;
    await api(`/api/leads/${lead!.id}`, { method: "DELETE" });
    reloadAll();
    nav("/leads");
  }

  const mockupSrc = `${fileUrl(lead.id, "mockup/index.html")}?v=${bust}`;

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/leads">Leads</Link>
        <span className="sep">/</span>
        {lead.benchmarks ? <Link to={`/leads?vertical=${lead.benchmarks.vertical}`}>{lead.benchmarks.label}</Link> : <span>Unclassified</span>}
        <span className="sep">/</span>
        <span className="here">{name}</span>
      </nav>

      <div className="title-row">
        <h1 className="page-title">{name}</h1>
        <div className="actions">
          <div className="pop-anchor">
            <button className="btn btn-white" onClick={() => setRerunOpen(!rerunOpen)} disabled={busy}><ChevronDown />Re-run</button>
            {rerunOpen && (
              <div className="popover" style={{ width: 280 }}>
                {STEPS.map((s) => (
                  <button key={s.key} className="notif" style={{ border: 0, background: "none", width: "100%", textAlign: "left", gridTemplateColumns: "minmax(0,1fr)" }} onClick={() => run(s.key)}>
                    <div><b>From {s.label.toLowerCase()}</b><span>{s.hint}</span></div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <a className="btn btn-white" href={`/api/leads/${lead.id}/export`} aria-disabled={!lead.hasMockup} style={!lead.hasMockup ? { pointerEvents: "none", opacity: .5 } : undefined}><FileOutput />Export</a>
          <a className="btn btn-white" href={lead.url} target="_blank" rel="noreferrer"><ExternalLink />Open site</a>
          {lead.hasMockup && <Link className="btn btn-ink" to={`/builds/new?lead=${lead.id}`}><Blocks />Start build</Link>}
        </div>
      </div>

      {lead.error && (
        <div className={`banner${lead.status === "failed" ? " err" : ""}`}>
          <AlertTriangle />
          <div>
            <b style={{ fontWeight: 500 }}>{lead.status === "paused" ? "Paused. It will retry automatically." : "The last run stopped."}</b> {lead.error}
          </div>
        </div>
      )}

      <div className="grid-main">
        <div className="stack">
          <div className="two">
            {/* Recent task */}
            <div className="card task-card">
              <div className="chips">
                <span className="chip">{shortDate(lead.createdAt)}{lastDone?.finishedAt ? ` – ${shortDate(lastDone.finishedAt)}` : ""}</span>
                <span className="chip"><Layers />{doneSteps.length} of {STEPS.length} steps</span>
                <span className="chip"><span className="dot" />{lastDone ? "Completed" : "Not started"}</span>
              </div>
              <div>
                <h4>{lastDone ? stepMeta(lastDone.key).label : "Recent task"}</h4>
                <p className="sub">{lastDone ? lastDone.note || stepMeta(lastDone.key).hint : "Nothing has finished yet"}</p>
              </div>
              <div className="task-foot">
                <div className="stack-dots" aria-label="Brand colours">
                  {swatches.slice(0, 3).map((c) => <span key={c} style={{ background: c }} title={c} />)}
                  {swatches.length > 3 && <span className="more">+{swatches.length - 3}</span>}
                  {!swatches.length && <span style={{ background: "var(--chip)" }} />}
                </div>
                {lead.hasSideBySide ? (
                  <a className="btn btn-ink btn-sm" href={fileUrl(lead.id, "side-by-side.png")} target="_blank" rel="noreferrer">View side-by-side <ArrowRight /></a>
                ) : (
                  <button className="btn btn-ink btn-sm" disabled>View side-by-side <ArrowRight /></button>
                )}
              </div>
            </div>

            {/* Upcoming task */}
            <div className="card task-card">
              <div className="chips">
                <span className="chip">{timeAgo(lead.createdAt)}</span>
                <span className="chip"><Users />{lead.benchmarks ? `${lead.benchmarks.sites.length} benchmarks` : "No benchmarks yet"}</span>
                <span className="chip"><span className="dot" />{next ? (next.status === "running" ? "In progress" : lead.status === "paused" ? "Paused" : next.status === "failed" ? "Failed" : "Up next") : "Done"}</span>
              </div>
              <div>
                <h4>{next ? stepMeta(next.key).label : "All steps complete"}</h4>
                <p className="sub">{next ? next.note || stepMeta(next.key).hint : lead.gate?.pass ? "Passed every quality check" : "Review the failing checks below"}</p>
              </div>
              <div className="task-foot">
                <div className="stack-dots" aria-label="Benchmark sites">
                  {(lead.benchmarks?.sites ?? []).slice(0, 3).map((s, i) => (
                    <span key={s.url} title={s.name} style={{ background: ["#3d3b3c", "#8a6d4f", "#5a8f93"][i] }}>{s.name[0]}</span>
                  ))}
                  {(lead.benchmarks?.sites.length ?? 0) > 3 && <span className="more">+{lead.benchmarks!.sites.length - 3}</span>}
                  {!lead.benchmarks && <span style={{ background: "var(--chip)" }} />}
                </div>
                <button className="btn btn-ink btn-sm" onClick={() => run()} disabled={busy || !next}>
                  {busy ? "Running" : next ? "Run now" : "Done"} <ArrowRight />
                </button>
              </div>
            </div>
          </div>

          <div className="review-head">
            <h2 className="section-title">Mockup review</h2>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <div className="seg" role="tablist" aria-label="Viewport">
                <button role="tab" aria-selected={view === "desktop"} className={view === "desktop" ? "on" : ""} onClick={() => setView("desktop")}><Monitor />Desktop</button>
                <button role="tab" aria-selected={view === "mobile"} className={view === "mobile" ? "on" : ""} onClick={() => setView("mobile")}><Smartphone />Mobile</button>
              </div>
              <button className="btn btn-white btn-icon" aria-label="Delete lead" onClick={remove}><Trash2 /></button>
            </div>
          </div>

          <div className="card card-lg stack" style={{ gap: 24 }}>
            <div className="compare">
              {/* Old site */}
              <section className="pane" aria-label="Current website">
                <div className="pane-head">
                  <span className="num">1</span>
                  <div><b>Current site</b><span>{host(lead.url)} · {live ? "live" : "screenshot"}</span></div>
                  <div className="pane-tools">
                    <button className="icon-btn" aria-label={live ? "Show screenshot" : "Try live page"} title={live ? "Show screenshot" : "Try live page"} onClick={() => setLive(!live)}>{live ? <ImageIcon /> : <RefreshCw />}</button>
                    <a className="icon-btn" aria-label="Open current site" href={lead.url} target="_blank" rel="noreferrer"><ArrowUpRight /></a>
                  </div>
                </div>
                <Viewport view={view}>
                  {(s) =>
                    live ? (
                      view === "desktop" ? (
                        <div className="scale-wrap" style={{ ["--s" as string]: s }}><iframe title="Current site" src={lead.url} sandbox="allow-scripts allow-same-origin" /></div>
                      ) : (
                        <iframe title="Current site" src={lead.url} sandbox="allow-scripts allow-same-origin" />
                      )
                    ) : captured ? (
                      <img src={fileUrl(lead.id, view === "desktop" ? "desktop.jpg" : "mobile.jpg")} alt={`Current ${view} homepage of ${host(lead.url)}`} />
                    ) : (
                      <Empty icon={<Clock />} text="The screenshot appears once capture finishes." />
                    )
                  }
                </Viewport>
              </section>

              {/* New mockup */}
              <section className="pane" aria-label="Rebuilt mockup">
                <div className="pane-head">
                  <span className="num">2</span>
                  <div><b>New mockup</b><span>{lead.gate ? `${lead.gate.checks.filter((c) => c.pass).length} of ${lead.gate.checks.length} checks passed` : lead.hasMockup ? "Checking…" : "Not generated yet"}</span></div>
                  <div className="pane-tools">
                    <a className="icon-btn" aria-label="Download mockup" href={`/api/leads/${lead.id}/export`} style={!lead.hasMockup ? { pointerEvents: "none", opacity: .4 } : undefined}><Download /></a>
                    <a className="icon-btn" aria-label="Open mockup full screen" href={fileUrl(lead.id, "mockup/index.html")} target="_blank" rel="noreferrer" style={!lead.hasMockup ? { pointerEvents: "none", opacity: .4 } : undefined}><ArrowUpRight /></a>
                  </div>
                </div>
                <Viewport view={view}>
                  {(s) =>
                    lead.hasMockup ? (
                      view === "desktop" ? (
                        <div className="scale-wrap" style={{ ["--s" as string]: s }}><iframe title="Mockup" src={mockupSrc} sandbox="allow-scripts" /></div>
                      ) : (
                        <iframe title="Mockup" src={mockupSrc} sandbox="allow-scripts" />
                      )
                    ) : (
                      <Empty icon={<Clock />} text={busy ? "Claude is building the mockup…" : "The mockup appears here once it's generated."} />
                    )
                  }
                </Viewport>
              </section>
            </div>

            {(lead.diagnosis || lead.gate) && (
              <div className="inset stack" style={{ gap: 16 }}>
                {lead.diagnosis && (
                  <div className="brand-row">
                    <span className="label-sm" style={{ margin: "0 6px 0 0" }}>Locked brand</span>
                    {Object.entries(lead.diagnosis.brand).filter(([, v]) => v).map(([k, v]) => (
                      <span key={k} className="swatch"><i style={{ background: v as string }} />{k} {v}</span>
                    ))}
                    {lead.diagnosis.strongestAsset && (
                      <a className="swatch" href={fileUrl(lead.id, lead.diagnosis.strongestAsset.path)} target="_blank" rel="noreferrer" title={lead.diagnosis.strongestAsset.reason}>
                        <i style={{ background: "var(--accent-soft)", display: "grid", placeItems: "center" }}><ImageIcon size={13} color="var(--accent)" /></i>
                        Hero {lead.diagnosis.strongestAsset.kind}
                      </a>
                    )}
                  </div>
                )}
                {lead.diagnosis?.lighthouse && (
                  <div className="scores">
                    {([["Performance", "performance"], ["Accessibility", "accessibility"], ["Best practices", "bestPractices"], ["SEO", "seo"]] as const).map(([l, k]) => {
                      const v = lead.diagnosis!.lighthouse![k];
                      return <div key={k} className="score"><b className={v >= 90 ? "ok" : v >= 50 ? "warn" : "bad"}>{v}</b><span>{l} (current site)</span></div>;
                    })}
                  </div>
                )}
                <div className="guides">
                  <div className="guide">
                    <h5>Issues found on the current site</h5>
                    <ul>
                      {(lead.diagnosis?.issues ?? []).map((i, n) => (
                        <li key={n}><span className={`sev ${i.severity}`} /><div>{i.title}<small>{i.detail}</small></div></li>
                      ))}
                      {!lead.diagnosis && <li><Info className="muted" /><div className="muted">Diagnosis is still running.</div></li>}
                    </ul>
                  </div>
                  <div className="guide">
                    <h5>Quality gate{lead.gate ? ` · attempt ${lead.gate.attempt}` : ""}</h5>
                    <ul>
                      {(lead.gate?.checks ?? []).map((c) => (
                        <li key={c.name}>{c.pass ? <CheckCircle2 className="ok" /> : <XCircle className="bad" />}<div>{c.name}<small>{c.detail}</small></div></li>
                      ))}
                      {!lead.gate && <li><Info className="muted" /><div className="muted">Checks run after the mockup is generated.</div></li>}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            <div className="bottom-actions">
              <a className="btn btn-outline" href={lead.url} target="_blank" rel="noreferrer">Open current site</a>
              <a className="btn btn-accent" href={fileUrl(lead.id, "mockup/index.html")} target="_blank" rel="noreferrer" style={!lead.hasMockup ? { pointerEvents: "none", opacity: .5 } : undefined}>Open mockup full screen</a>
            </div>
          </div>
        </div>

        {/* Right column */}
        <div className="stack side-col">
          <div className="card">
            <div className="notif-list">
              {leadEvents.map((e, i) => (
                <button key={e.id} className={`notif${i === 1 ? " hl" : ""}`} style={{ border: 0, textAlign: "left", background: undefined }} onClick={() => e.leadId && nav(`/leads/${e.leadId}`)}>
                  <span className="tile"><EventIcon kind={e.kind} /></span>
                  <div><b>{e.title}</b><span>{e.detail}</span></div>
                  <ArrowUpRight />
                </button>
              ))}
              {!leadEvents.length && <p className="side-empty" style={{ padding: 10 }}>No activity yet</p>}
            </div>
            <div className="notif-foot">
              <button className="btn btn-ink btn-sm" onClick={() => nav("/leads")}>See all leads <ArrowRight /></button>
              <a className="link-btn" href={`mailto:${lead.email}`} style={!lead.email ? { pointerEvents: "none", opacity: .5 } : undefined}><StickyNote />Email lead</a>
            </div>
          </div>

          <div className="card">
            <h3 className="card-title">Form entries <ArrowUpRight size={22} strokeWidth={1.6} /></h3>
            <p className="card-sub">Submitted via {lead.source === "meta" ? "Meta Lead Ads" : lead.source === "elementor" ? "Elementor" : lead.source === "maps" ? "Lead Finder (Google Maps)" : "manual entry"} · {timeAgo(lead.createdAt)}</p>
            <dl className="fields">
              {Object.entries(lead.fields).map(([k, v]) => (
                <div key={k} className="field"><dt>{k}</dt><dd>{v || "—"}</dd></div>
              ))}
            </dl>
            <div style={{ marginTop: 14 }}><StatusPill status={lead.status} /></div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3 className="card-title">Pipeline</h3>
              <button className="btn btn-chip btn-xs" onClick={() => run("capture")} disabled={busy}><RefreshCw size={14} />Restart</button>
            </div>
            <div className="steps">
              {lead.steps.map((s) => {
                const m = stepMeta(s.key);
                const d = duration(s.startedAt, s.finishedAt);
                return (
                  <div key={s.key} className={`step${s.status === "running" ? " running" : ""}`} title={s.note}>
                    <div>
                      <b>{m.label}</b>
                      <span>{s.status === "done" ? `${d || "Done"}${s.note ? " · " + s.note : ""}` : s.status === "running" ? s.note || "Running…" : s.status === "failed" ? s.note || "Failed" : m.hint}</span>
                    </div>
                    <span className="ico"><StepIcon status={s.status} /></span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
