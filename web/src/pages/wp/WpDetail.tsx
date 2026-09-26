import { useEffect, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import {
  AlertTriangle, ArrowRight, CheckCircle2, Download, Gauge, ExternalLink, Info, KeyRound, Loader2, Monitor, Plug, Puzzle, Send, Smartphone, Trash2, XCircle,
} from "lucide-react";
import type { WpConversion } from "../../../../shared/types";
import type { LayoutCtx } from "../../layout/Layout";
import { api, host, timeAgo, usePoll } from "../../lib/api";
import { Dropdown } from "../../components/Dropdown";
import { WpPagePill, WpStatusPill } from "./WpList";
import { StorePanel } from "./WpStore";

type Detail = WpConversion & { queued: string[]; pluginFile: boolean };

export default function WpDetail() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const { reloadAll } = useOutletContext<LayoutCtx>();
  const { data: c, error, reload } = usePoll<Detail>(`/api/wp/${id}`, 3000);
  const [view, setView] = useState<"desktop" | "mobile">("desktop");
  const [compare, setCompare] = useState<"side" | "diff">("side");
  const [feedback, setFeedback] = useState("");
  const [section, setSection] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [creds, setCreds] = useState({ wpUser: "", appPassword: "" });
  const [busy, setBusy] = useState<string | null>(null);

  // Default to the page that needs attention.
  const focus = params.get("page");
  useEffect(() => {
    if (!c || focus) return;
    const p = c.pages.find((x) => x.status === "awaiting_approval" || x.status === "converting" || x.status === "changes_requested") ?? c.pages.find((x) => x.status !== "approved") ?? c.pages[0];
    if (p) setParams({ page: p.slug }, { replace: true });
  }, [c, focus, setParams]);

  if (error && !c) return <div className="banner err"><XCircle />{error}</div>;
  if (!c) return <p className="muted">Loading…</p>;
  const page = c.pages.find((p) => p.slug === focus) ?? c.pages[0];
  const approved = c.pages.filter((p) => p.status === "approved").length;
  const working = c.status === "running" || c.pages.some((p) => p.status === "converting" || p.status === "changes_requested");
  const shot = (kind: "html" | "wp" | "diff") => `/files/wp/${c.id}/pages/${page.slug}/${view}-${kind}.png?v=${encodeURIComponent(page.updatedAt ?? "")}`;
  const canStart = Boolean(c.connected?.ok) && !working && !c.pages.some((p) => p.status === "awaiting_approval") && c.pages.some((p) => p.status === "pending" || p.status === "failed");

  async function act(kind: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(kind);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ ok: true, text: ok });
      void reload();
      reloadAll();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
      void reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/wp/all">WordPress</Link><span className="sep">/</span><span className="here">{c.business}</span></nav>
      <div className="title-row">
        <div>
          <h1 className="page-title">{c.business}</h1>
          <p className="muted" style={{ marginTop: 8 }}>
            <a className="ext-link" href={c.siteUrl} target="_blank" rel="noreferrer">{host(c.siteUrl)}</a> · {c.elementorPro ? "Elementor Pro" : "Elementor free + custom widgets"} · {approved}/{c.pages.length} pages approved
          </p>
        </div>
        <div className="actions">
          <WpStatusPill status={c.status} />
          <a className="btn btn-white" href={`/api/wp/${c.id}/plugin`}><Download />Connector plugin v1.0.{c.pluginVersion}</a>
          {c.status === "done" && <Link className="btn btn-white" to={`/seo/new?conversion=${c.id}`}><Gauge />Post-launch QA & SEO</Link>}
          <button className="btn btn-ink" disabled={!canStart || busy !== null} onClick={() => act("start", () => api(`/api/wp/${c.id}/start`, { method: "POST" }))}>
            {approved === 0 && c.pages.every((p) => p.status === "pending") ? "Start conversion" : "Continue"} <ArrowRight />
          </button>
        </div>
      </div>

      {c.error && (c.status === "paused" || c.status === "failed") && (
        <div className={`banner${c.status === "failed" ? " err" : ""}`}><AlertTriangle /><div><b style={{ fontWeight: 500 }}>{c.status === "paused" ? "Waiting on you." : "Stopped."}</b> {c.error}</div></div>
      )}
      {msg && <div className={`banner${msg.ok ? "" : " err"}`} style={msg.ok ? { background: "#eaf4ee", color: "#2f6f4a" } : undefined}>{msg.ok ? <CheckCircle2 /> : <XCircle />}{msg.text}</div>}

      <div className="grid-main">
        <div className="stack">
          {/* Setup until the site answers */}
          {!c.connected?.ok && (
            <section className="set-section">
              <h3 className="set-title"><Plug />Connect the site</h3>
              <div className="set-body">
                <ol className="steps-list setup-steps">
                  <li><b>Install the connector.</b> Download <a className="ext-link" href={`/api/wp/${c.id}/plugin`}>studio-connector.zip</a>, then in WordPress go to Plugins → Add New → Upload Plugin and activate it.</li>
                  <li><b>Create an Application Password.</b> Open <a className="ext-link" href={`${c.siteUrl}/wp-admin/profile.php#application-passwords-section`} target="_blank" rel="noreferrer">Users → Profile</a> on the client site, add one called “Studio” and paste it below.</li>
                  <li><b>Test the connection.</b></li>
                </ol>
                <div className="set-grid">
                  <div className="set-field">
                    <label htmlFor="c-user">WordPress username</label>
                    <input id="c-user" className="input" placeholder={c.wpUser || "admin"} value={creds.wpUser} onChange={(e) => setCreds({ ...creds, wpUser: e.target.value })} autoComplete="off" />
                  </div>
                  <div className="set-field">
                    <label htmlFor="c-pass">Application Password</label>
                    <div className="input-icon"><KeyRound /><input id="c-pass" className="input mono" type="password" placeholder={c.appPasswordSet ? "•••••••• saved" : "xxxx xxxx xxxx xxxx"} value={creds.appPassword} onChange={(e) => setCreds({ ...creds, appPassword: e.target.value })} autoComplete="off" /></div>
                  </div>
                </div>
                <div className="set-actions">
                  <button type="button" className="btn btn-ink btn-sm" disabled={busy !== null} onClick={() => act("test", async () => {
                    if (creds.wpUser || creds.appPassword) await api(`/api/wp/${c.id}/credentials`, { method: "PUT", json: creds });
                    await api(`/api/wp/${c.id}/test`, { method: "POST" });
                  }, "Connected. Elementor answered.")}>
                    {busy === "test" ? "Testing…" : "Save & test connection"}
                  </button>
                </div>
              </div>
            </section>
          )}

          <div className="review-head">
            <div className="page-tabs" role="tablist" aria-label="Pages">
              {c.pages.map((p) => (
                <button key={p.slug} role="tab" aria-selected={p.slug === page.slug} className={`page-tab${p.slug === page.slug ? " on" : ""}`} onClick={() => setParams({ page: p.slug })}>
                  {p.status === "approved" ? <CheckCircle2 className="ok" /> : p.status === "awaiting_approval" ? <AlertTriangle className="warn" /> : p.status === "converting" || p.status === "changes_requested" ? <Loader2 className="spin" /> : null}
                  {p.title}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <div className="seg" role="tablist" aria-label="Compare">
                <button role="tab" aria-selected={compare === "side"} className={compare === "side" ? "on" : ""} onClick={() => setCompare("side")}>Side by side</button>
                <button role="tab" aria-selected={compare === "diff"} className={compare === "diff" ? "on" : ""} onClick={() => setCompare("diff")}>Differences</button>
              </div>
              <div className="seg" role="tablist" aria-label="Viewport">
                <button role="tab" aria-selected={view === "desktop"} className={view === "desktop" ? "on" : ""} onClick={() => setView("desktop")}><Monitor />Desktop</button>
                <button role="tab" aria-selected={view === "mobile"} className={view === "mobile" ? "on" : ""} onClick={() => setView("mobile")}><Smartphone />Mobile</button>
              </div>
            </div>
          </div>

          <div className="card card-lg stack" style={{ gap: 20 }}>
            <div className="card-head">
              <div>
                <h3 className="card-title" style={{ fontSize: 24 }}>{page.title}</h3>
                <p className="card-sub">{page.updatedAt ? `Converted ${timeAgo(page.updatedAt)}` : page.note ?? "Not converted yet"}</p>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                {page.diff && <span className={`diff-chip ${page.diff[view]! <= 3 ? "good" : page.diff[view]! <= 10 ? "ok" : "bad"}`}>{page.diff[view]}% pixels differ</span>}
                <WpPagePill status={page.status} />
              </div>
            </div>

            {page.diff ? (
              compare === "side" ? (
                <div className={`shot-compare ${view}`}>
                  <figure><figcaption>HTML build</figcaption><div className="shot-scroll"><img src={shot("html")} alt={`HTML ${page.title} at ${view} width`} /></div></figure>
                  <figure><figcaption>WordPress + Elementor</figcaption><div className="shot-scroll"><img src={shot("wp")} alt={`WordPress ${page.title} at ${view} width`} /></div></figure>
                </div>
              ) : (
                <div className={`shot-compare single ${view}`}>
                  <figure><figcaption>Red marks pixels that differ between the two</figcaption><div className="shot-scroll"><img src={shot("diff")} alt="Pixel difference map" /></div></figure>
                </div>
              )
            ) : (
              <div className="viewport" style={{ height: 360 }}><div className="empty-pane"><div>{page.status === "converting" ? <Loader2 className="spin" /> : <Info />}<p>{page.status === "converting" ? "Converting section by section…" : page.note ?? "This page hasn't been converted yet."}</p></div></div></div>
            )}

            {page.status === "awaiting_approval" && (
              <div className="inset stack" style={{ gap: 14 }}>
                <div className="approve-row">
                  <div>
                    <b>Happy with {page.title}?</b>
                    <p className="muted" style={{ fontSize: 14 }}>Approving starts the next page. Open it in Elementor to check the editor too.</p>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <a className="btn btn-white btn-sm" href={page.wpUrl} target="_blank" rel="noreferrer"><ExternalLink />Open in Elementor</a>
                    <button className="btn btn-accent btn-sm" disabled={busy !== null} onClick={() => act("approve", () => api(`/api/wp/${c.id}/pages/${page.slug}/approve`, { method: "POST" }), `${page.title} approved.`)}><CheckCircle2 />Approve & continue</button>
                  </div>
                </div>
                <div className="set-field" style={{ background: "var(--card)" }}>
                  <label htmlFor="fb">Or request changes</label>
                  <div className="set-grid">
                    <Dropdown field label="Section" value={section} onChange={setSection}
                      options={[{ value: "", label: "Whole page" }, ...page.sections.map((s) => ({ value: String(s.index), label: s.label, hint: s.widgets.join(", ") }))]} />
                    <span />
                  </div>
                  <textarea id="fb" className="input textarea" rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="e.g. The hero heading wraps onto three lines, and the button radius should be 8px" />
                  <div><button className="btn btn-ink btn-sm" disabled={feedback.trim().length < 3 || busy !== null} onClick={() => act("changes", async () => {
                    await api(`/api/wp/${c.id}/pages/${page.slug}/changes`, { method: "POST", json: { feedback, sectionIndex: section } });
                    setFeedback("");
                  }, "Sent. Claude is revising it.")}><Send />Send to Claude</button></div>
                </div>
              </div>
            )}
          </div>
          <StorePanel c={c} reload={() => void reload()} />
        </div>

        <div className="stack side-col">
          <div className="card">
            <div className="card-head"><h3 className="card-title">Pages</h3><span className="muted" style={{ fontSize: 14 }}>{approved}/{c.pages.length}</span></div>
            <div className="steps">
              {c.pages.map((p, i) => (
                <button key={p.slug} type="button" className={`step${p.slug === page.slug ? " running" : ""}`} style={{ textAlign: "left", background: undefined }} onClick={() => setParams({ page: p.slug })}>
                  <div><b>{i + 1}. {p.title}</b><span>{p.diff ? `${p.diff.desktop}% / ${p.diff.mobile}% differ` : p.status === "converting" ? `${p.sections.filter((s) => s.status === "done").length}/${p.sections.length || "?"} sections` : "Not started"}</span></div>
                  <span className="ico">{p.status === "approved" ? <CheckCircle2 className="ok" /> : p.status === "awaiting_approval" ? <AlertTriangle className="warn" /> : p.status === "converting" || p.status === "changes_requested" ? <Loader2 className="spin" style={{ color: "var(--accent)" }} /> : p.status === "failed" ? <XCircle className="bad" /> : <span className="dot-pending" />}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="card">
            <h3 className="card-title">Sections</h3>
            <p className="card-sub">{page.title}: widgets used per section</p>
            <dl className="fields">
              {page.sections.map((s) => (
                <div key={s.index} className="field"><dt>{s.label}</dt><dd>{s.status === "done" ? s.widgets.join(", ") || "containers" : s.status}{s.note ? <small className="muted" style={{ display: "block" }}>{s.note}</small> : null}</dd></div>
              ))}
              {!page.sections.length && <div className="field"><dt>—</dt><dd className="muted">Sections appear once conversion starts</dd></div>}
            </dl>
          </div>

          <div className="card">
            <h3 className="card-title">Connection</h3>
            <dl className="fields">
              <div className="field"><dt>Status</dt><dd>{c.connected?.ok ? <span className="ok">Connected</span> : <span className="bad">Not connected</span>}</dd></div>
              <div className="field"><dt>Elementor</dt><dd>{c.connected?.elementor || "—"}{c.connected?.ok ? (c.connected.pro ? " + Pro" : " (free)") : ""}</dd></div>
              <div className="field"><dt>Plugin</dt><dd>{c.connected?.plugin ? `v${c.connected.plugin} installed` : "—"} · latest v1.0.{c.pluginVersion}</dd></div>
            </dl>
            {c.connected?.ok && <button className="btn btn-chip btn-sm" style={{ marginTop: 14 }} disabled={busy !== null} onClick={() => act("test", () => api(`/api/wp/${c.id}/test`, { method: "POST" }), "Connection OK.")}><Plug />Test again</button>}
          </div>

          {!c.elementorPro && (
            <div className="card">
              <h3 className="card-title">Custom widgets</h3>
              <p className="card-sub">Stand-ins for Pro widgets, shipped in the connector plugin</p>
              <dl className="fields">
                {c.customWidgets.map((w) => <div key={w.name} className="field"><dt><Puzzle size={14} /> {w.title}</dt><dd>replaces {w.replaces} · {w.forPage}</dd></div>)}
                {!c.customWidgets.length && <div className="field"><dt>None yet</dt><dd className="muted">Free widgets have covered everything so far.</dd></div>}
              </dl>
            </div>
          )}

          <button className="btn btn-ghost" style={{ alignSelf: "flex-start" }} disabled={working} onClick={() => { if (confirm("Delete this conversion from the dashboard? Pages already in WordPress stay there.")) void act("del", async () => { await api(`/api/wp/${c.id}`, { method: "DELETE" }); nav("/wp/all"); }); }}><Trash2 />Delete conversion</button>
        </div>
      </div>
    </>
  );
}
