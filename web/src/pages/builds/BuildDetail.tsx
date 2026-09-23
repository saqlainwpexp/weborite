import { useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import {
  AlertTriangle, ArrowUpRight, CheckCircle2, ChevronDown, PanelsTopLeft, Download, ExternalLink, Info, Monitor, PenLine, Send, Smartphone, Trash2, XCircle,
} from "lucide-react";
import { BUILD_STEPS, type Build, type BuildStepKey } from "../../../../shared/types";
import type { LayoutCtx } from "../../layout/Layout";
import { api, duration, host, timeAgo, usePoll } from "../../lib/api";
import { StepIcon } from "../../components/ui";
import { BuildStatusPill, PreviewFrame } from "../../components/builds";

type Detail = Build & { hasZip: boolean };
const fileFor = (slug: string) => (slug === "index" ? "index.html" : `${slug}.html`);

export default function BuildDetail() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { reloadAll } = useOutletContext<LayoutCtx>();
  const { data: b, error, reload } = usePoll<Detail>(`/api/builds/${id}`, 3000);
  const [slug, setSlug] = useState("index");
  const [view, setView] = useState<"desktop" | "mobile">("desktop");
  const [changes, setChanges] = useState("");
  const [rerunOpen, setRerunOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (error && !b) return <div className="banner err"><XCircle />{error}</div>;
  if (!b) return <p className="muted">Loading…</p>;

  const busy = b.status === "running" || b.status === "queued";
  const page = b.pages.find((p) => p.slug === slug) ?? b.pages[0];
  const written = b.pages.filter((p) => p.status === "done").length;
  const bust = page.updatedAt ?? "";
  const src = `/files/builds/${b.id}/site/${fileFor(page.slug)}?v=${encodeURIComponent(bust)}`;
  // Site files are written once every page exists.
  const pageViewable = page.status === "done" && b.steps.find((s) => s.key === "pages")?.status === "done";

  async function run(from?: BuildStepKey) {
    setRerunOpen(false);
    await api(`/api/builds/${b!.id}/start`, { method: "POST", json: from ? { from } : {} });
    void reload();
    reloadAll();
  }

  async function revise() {
    setMsg(null);
    try {
      await api(`/api/builds/${b!.id}/pages/${page.slug}/revise`, { method: "POST", json: { changes } });
      setChanges("");
      setMsg(`Queued: Claude is revising ${page.title}.`);
      void reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function remove() {
    if (!confirm(`Delete the ${b!.business} build and all its files?`)) return;
    await api(`/api/builds/${b!.id}`, { method: "DELETE" });
    reloadAll();
    nav("/builds/all");
  }

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/builds/all">Builds</Link><span className="sep">/</span><span className="here">{b.business}</span>
      </nav>
      <div className="title-row">
        <div>
          <h1 className="page-title">{b.business}</h1>
          <p className="muted" style={{ marginTop: 8 }}>{host(b.url)} · {b.pages.length} pages · started {timeAgo(b.createdAt)}</p>
        </div>
        <div className="actions">
          <BuildStatusPill status={b.status} />
          {b.status === "draft" ? (
            <button className="btn btn-ink" onClick={() => run()}>Start build</button>
          ) : (
            <div className="pop-anchor">
              <button className="btn btn-white" onClick={() => setRerunOpen(!rerunOpen)} disabled={busy}><ChevronDown />Re-run</button>
              {rerunOpen && (
                <div className="popover menu" style={{ width: 280 }}>
                  {BUILD_STEPS.map((s) => (
                    <button key={s.key} type="button" className="menu-item" onClick={() => run(s.key)}>
                      <span className="menu-text"><b>From {s.label.toLowerCase()}</b><small>{s.hint}</small></span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <Link className="btn btn-white" to={`/builds/${b.id}/edit`} aria-disabled={busy} style={busy ? { pointerEvents: "none", opacity: .5 } : undefined}><PenLine />Edit brief</Link>
          {(b.status === "ready" || b.status === "needs_review") && <Link className="btn btn-white" to={`/wp/new?build=${b.id}`}><PanelsTopLeft />Convert to WordPress</Link>}
          <a className="btn btn-ink" href={`/api/builds/${b.id}/download`} aria-disabled={!b.hasZip} style={!b.hasZip ? { pointerEvents: "none", opacity: .5 } : undefined}><Download />Download site</a>
        </div>
      </div>

      {b.error && (b.status === "failed" || b.status === "paused") && (
        <div className={`banner${b.status === "failed" ? " err" : ""}`}><AlertTriangle /><div><b style={{ fontWeight: 500 }}>{b.status === "paused" ? "Paused. It will retry automatically." : "The build stopped."}</b> {b.error}</div></div>
      )}

      <div className="grid-main">
        <div className="stack">
          <div className="review-head">
            <div className="page-tabs" role="tablist" aria-label="Pages">
              {b.pages.map((p) => (
                <button key={p.slug} role="tab" aria-selected={p.slug === page.slug} className={`page-tab${p.slug === page.slug ? " on" : ""}`} onClick={() => setSlug(p.slug)}>
                  {p.pass === false ? <AlertTriangle className="warn" /> : p.pass ? <CheckCircle2 className="ok" /> : null}
                  {p.title}
                </button>
              ))}
            </div>
            <div className="seg" role="tablist" aria-label="Viewport">
              <button role="tab" aria-selected={view === "desktop"} className={view === "desktop" ? "on" : ""} onClick={() => setView("desktop")}><Monitor />Desktop</button>
              <button role="tab" aria-selected={view === "mobile"} className={view === "mobile" ? "on" : ""} onClick={() => setView("mobile")}><Smartphone />Mobile</button>
            </div>
          </div>

          <div className="card card-lg stack" style={{ gap: 20 }}>
            <div className="pane-head">
              <span className="num">{b.pages.indexOf(page) + 1}</span>
              <div><b>{page.title}</b><span>{fileFor(page.slug)} · {page.status === "done" ? `updated ${timeAgo(page.updatedAt)}` : page.status === "running" ? "Claude is writing…" : page.status === "failed" ? "Failed" : "Waiting"}</span></div>
              <div className="pane-tools">
                <a className="icon-btn" aria-label="Open page in a new tab" href={src} target="_blank" rel="noreferrer" style={!pageViewable ? { pointerEvents: "none", opacity: .4 } : undefined}><ArrowUpRight /></a>
              </div>
            </div>
            {pageViewable ? (
              <PreviewFrame key={src + view} src={src} view={view} title={`${page.title} preview`} />
            ) : (
              <div className="viewport" style={{ height: 420 }}><div className="empty-pane"><div><Info /><p>{busy ? "This page appears here once it's written." : "Start the build to generate this page."}</p></div></div></div>
            )}

            <div className="inset stack" style={{ gap: 16 }}>
              <div className="guides">
                <div className="guide">
                  <h5>Brief</h5>
                  <p style={{ fontSize: 14, lineHeight: 1.5 }}>{page.brief || "No brief. Claude writes a standard page for this business."}</p>
                </div>
                <div className="guide">
                  <h5>Quality checks{page.pass === null ? "" : page.pass ? " · passed" : " · needs review"}</h5>
                  <ul>
                    {page.checks.map((c) => (
                      <li key={c.name}>{c.pass ? <CheckCircle2 className="ok" /> : <XCircle className="bad" />}<div>{c.name}<small>{c.detail}</small></div></li>
                    ))}
                    {!page.checks.length && <li><Info className="muted" /><div className="muted">Checks run after all pages are written.</div></li>}
                  </ul>
                </div>
              </div>
              <div className="set-field" style={{ background: "var(--card)" }}>
                <label htmlFor="rev">Request changes to {page.title}</label>
                <textarea id="rev" className="input textarea" rows={3} value={changes} onChange={(e) => setChanges(e.target.value)} placeholder="e.g. Add a section about emergency call-outs, shorten the intro" disabled={page.status !== "done" || busy} />
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <button type="button" className="btn btn-accent btn-sm" disabled={changes.trim().length < 3 || page.status !== "done" || busy} onClick={revise}><Send />Revise this page</button>
                  {page.pendingChanges && <span className="muted" style={{ fontSize: 13 }}>Revision queued: “{page.pendingChanges.slice(0, 80)}”</span>}
                  {msg && <span className="muted" style={{ fontSize: 13 }}>{msg}</span>}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="stack side-col">
          <div className="card">
            <div className="card-head">
              <h3 className="card-title">Pipeline</h3>
              <span className="muted" style={{ fontSize: 14 }}>{written}/{b.pages.length} pages</span>
            </div>
            <div className="steps">
              {b.steps.map((s) => {
                const m = BUILD_STEPS.find((x) => x.key === s.key)!;
                const d = duration(s.startedAt, s.finishedAt);
                return (
                  <div key={s.key} className={`step${s.status === "running" ? " running" : ""}`} title={s.note}>
                    <div><b>{m.label}</b><span>{s.status === "done" ? `${d || "Done"}${s.note ? " · " + s.note : ""}` : s.status === "running" ? (s.key === "pages" ? `Writing ${b.pages.find((p) => p.status === "running")?.title ?? "pages"}…` : s.note || "Running…") : s.status === "failed" ? s.note || "Failed" : m.hint}</span></div>
                    <span className="ico"><StepIcon status={s.status} /></span>
                  </div>
                );
              })}
            </div>
            {b.linkCheck && (
              <p className={`link-check ${b.linkCheck.pass ? "ok" : "bad"}`}>{b.linkCheck.pass ? <CheckCircle2 /> : <XCircle />}{b.linkCheck.detail}</p>
            )}
          </div>

          <div className="card">
            <h3 className="card-title">Brief</h3>
            <dl className="fields">
              <div className="field"><dt>Mockup</dt><dd><Link className="ext-link" to={`/leads/${b.leadId}`}>{b.business}</Link></dd></div>
              <div className="field"><dt>Homepage changes</dt><dd className="pre">{b.homepageChanges || "None"}</dd></div>
              <div className="field"><dt>Project details</dt><dd className="pre clamp">{b.details || "None provided"}</dd></div>
            </dl>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {b.hasZip && <a className="btn btn-ghost" href={`/files/builds/${b.id}/site/index.html`} target="_blank" rel="noreferrer"><ExternalLink />Open full site</a>}
            <button className="btn btn-ghost" onClick={remove} disabled={busy}><Trash2 />Delete build</button>
          </div>
        </div>
      </div>
    </>
  );
}
