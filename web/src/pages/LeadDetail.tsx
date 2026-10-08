import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import {
  AlertTriangle, ArrowRight, ArrowUpRight, Blocks, Check, CheckCircle2, ChevronDown, Clock, Copy, Download, ExternalLink,
  FileOutput, Globe, Image as ImageIcon, Info, Layers, Loader2, Mail, MessageCircle, Monitor, PanelsTopLeft, RefreshCw, Rocket, Send, Smartphone, Sparkles, Star, StickyNote,
  Target, Trash2, Users, Wand2, Wrench, X, XCircle,
} from "lucide-react";
import { LEAD_TEMP, STEPS, type LeadDetail as Detail, type StepKey } from "../../../shared/types";
import { workspaceEnabled } from "../../../shared/features";
import type { LayoutCtx } from "../layout/Layout";
import { api, duration, fileUrl, host, shortDate, timeAgo, usePoll } from "../lib/api";
import { StatusPill, StepIcon } from "../components/ui";
import { DEFAULT_PAGES } from "../components/builds";

type View = "desktop" | "mobile";
type Tab = "overview" | "redesign" | "outreach" | "seo" | "competitors" | "close";

const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: "overview", label: "Overview", icon: <Layers /> },
  { key: "redesign", label: "Redesign", icon: <Wand2 /> },
  { key: "outreach", label: "Outreach", icon: <Send /> },
  { key: "seo", label: "SEO audit", icon: <Globe /> },
  { key: "competitors", label: "Competitors", icon: <Users /> },
  { key: "close", label: "How to close", icon: <Target /> },
];

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

function Viewport({ view, height, children }: { view: View; height?: number; children: (scale: number) => React.ReactNode }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  return (
    <div className={`viewport ${view}`} style={height ? { height } : undefined}>
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
  const { reloadAll } = useOutletContext<LayoutCtx>();
  const { data: lead, error, reload } = usePoll<Detail>(`/api/leads/${id}`, 3000);
  const [view, setView] = useState<View>("desktop");
  const [tab, setTab] = useState<Tab>("overview");
  const [live, setLive] = useState(false);
  const scratch = lead?.mode === "scratch";
  const [rerunOpen, setRerunOpen] = useState(false);
  const [bust, setBust] = useState(0);

  // Rating + feedback on the generated mockup.
  const [rating, setRating] = useState<number | undefined>(undefined);
  const [feedback, setFeedback] = useState("");
  const [savedNote, setSavedNote] = useState(false);
  const fbInit = useRef(false);

  // "Request changes" prompt box.
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseText, setReviseText] = useState("");
  const [reviseBusy, setReviseBusy] = useState(false);
  const [reviseErr, setReviseErr] = useState<string | null>(null);

  // Outreach email — drafted after the gate, regenerated on demand, shown in the Outreach tab.
  const [pitch, setPitch] = useState<{ subject: string; body: string } | null>(null);
  const [pitchBusy, setPitchBusy] = useState(false);
  const [pitchErr, setPitchErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pitchInit = useRef(false);
  // Sending the email over SMTP (the configured outreach mailbox).
  const [attachMockup, setAttachMockup] = useState(true);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testSent, setTestSent] = useState(false);
  // WhatsApp message (opens wa.me with the text prefilled).
  const [waText, setWaText] = useState("");
  const waInit = useRef(false);

  // "How to close this lead" — the strategy playbook (shown in its own tab, separate from the email).
  const [play, setPlay] = useState<Detail["playbook"]>(null);
  const [playBusy, setPlayBusy] = useState(false);
  const [playErr, setPlayErr] = useState<string | null>(null);

  // Publish live (Hostinger).
  const [pubBusy, setPubBusy] = useState(false);
  const [pubErr, setPubErr] = useState<string | null>(null);

  // CRM notes + one-click pipeline advance.
  const [notes, setNotes] = useState("");
  const [savedNotes, setSavedNotes] = useState("");
  const [notesSaved, setNotesSaved] = useState(false);
  const [advBusy, setAdvBusy] = useState(false);

  // Refresh the mockup iframe when a new version lands.
  const genDone = lead?.steps.find((s) => s.key === "generate")?.finishedAt;
  useEffect(() => setBust(Date.now()), [genDone]);

  // Seed the rating/feedback/notes controls once from the loaded lead.
  useEffect(() => {
    if (fbInit.current || !lead) return;
    fbInit.current = true;
    setRating(lead.rating);
    setFeedback(lead.feedback ?? "");
    setNotes(lead.notes ?? "");
    setSavedNotes(lead.notes ?? "");
  }, [lead]);

  // Seed the WhatsApp message once, using the live mockup link when it's published.
  useEffect(() => {
    if (waInit.current || !lead) return;
    waInit.current = true;
    const who = lead.business || host(lead.url);
    const link = lead.publish?.url ? ` You can see it here: ${/^https?:\/\//i.test(lead.publish.url) ? lead.publish.url : `https://${lead.publish.url}`}` : "";
    setWaText(`Hi, I put together a new homepage design for ${who} — I think it'll help you win more customers.${link} Can I send it over?`);
  }, [lead]);

  async function saveNotes() {
    try {
      await api(`/api/leads/${id}/notes`, { method: "POST", json: { notes } });
      setSavedNotes(notes);
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 1500);
      reloadAll();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  // One-click: turn the approved mockup into a full website build and open it.
  async function startBuild() {
    setAdvBusy(true);
    try {
      const b = await api<{ id: string }>("/api/builds", { method: "POST", json: { leadId: lead!.id, pages: DEFAULT_PAGES, start: true } });
      reloadAll();
      nav(`/builds/${b.id}`);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setAdvBusy(false);
    }
  }

  async function saveFeedback(next: { rating?: number; feedback?: string }) {
    try {
      await api(`/api/leads/${id}/feedback`, { method: "POST", json: next });
      setSavedNote(true);
      setTimeout(() => setSavedNote(false), 1500);
    } catch { /* a transient save failure is non-fatal; the next change retries */ }
  }

  async function submitRevise() {
    const text = reviseText.trim();
    if (!text) return;
    setReviseBusy(true);
    setReviseErr(null);
    try {
      await api(`/api/leads/${id}/revise`, { method: "POST", json: { text } });
      setReviseOpen(false);
      setReviseText("");
      void reload();
      reloadAll();
    } catch (e) {
      setReviseErr((e as Error).message);
    } finally {
      setReviseBusy(false);
    }
  }

  if (error && !lead) return <div className="banner err"><XCircle />{error}</div>;
  if (!lead) return <p className="muted">Loading…</p>;

  const name = lead.business || host(lead.url);
  const stepMeta = (k: StepKey) => STEPS.find((s) => s.key === k)!;
  const doneSteps = lead.steps.filter((s) => s.status === "done");
  const next = lead.steps.find((s) => s.status !== "done");
  const captured = lead.steps[0].status === "done";
  const brand = lead.diagnosis?.brand;
  const swatches = brand ? [brand.primary, brand.secondary, brand.accent, brand.text].filter(Boolean) as string[] : [];
  const busy = lead.status === "running" || lead.status === "queued";

  // Overview widgets.
  const gatePass = lead.gate ? lead.gate.checks.filter((c) => c.pass).length : 0;
  const gateTotal = lead.gate?.checks.length ?? 0;
  const gateCls = !lead.gate ? "" : gatePass === gateTotal ? "good" : gatePass * 2 >= gateTotal ? "warn" : "bad";
  const scoreCls = lead.score === undefined ? "" : lead.score >= 70 ? "good" : lead.score >= 45 ? "warn" : "bad";
  const sourceLabel = lead.source === "meta" ? "Meta Lead Ads" : lead.source === "elementor" ? "Elementor" : lead.source === "maps" ? "Lead Finder (Google Maps)" : "Manual entry";

  // Delivery pipeline (Mockup → Build → WordPress → Launch → Maintenance) for the one-click advance card.
  const pipe = lead.pipeline ?? { build: null, conversion: null };
  const buildReady = pipe.build?.status === "ready" || pipe.build?.status === "needs_review";
  const convDone = pipe.conversion?.status === "done";
  const stageList = [
    { key: "mockup", label: "Mockup", done: lead.hasMockup, started: busy || lead.hasMockup },
    { key: "build", label: "Website build", done: buildReady, started: !!pipe.build },
    { key: "wordpress", label: "WordPress", done: convDone, started: !!pipe.conversion },
    { key: "launch", label: "Launch & SEO", done: false, started: false },
    { key: "care", label: "Maintenance", done: false, started: false },
  ];
  const nextStep: { label: string; icon: React.ReactNode; onClick?: () => void; to?: string; disabled?: boolean } =
    !lead.hasMockup ? { label: busy ? "Mockup in progress…" : "Finish the mockup first", icon: <Sparkles />, disabled: true }
    : !pipe.build ? { label: "Build full website", icon: <Blocks />, onClick: () => void startBuild() }
    : !buildReady ? { label: "Open build in progress", icon: <Blocks />, to: `/builds/${pipe.build.id}` }
    : !pipe.conversion ? { label: "Convert to WordPress", icon: <PanelsTopLeft />, to: `/wp/new?build=${pipe.build.id}` }
    : !convDone ? { label: "Open WordPress conversion", icon: <PanelsTopLeft />, to: `/wp/${pipe.conversion.id}` }
    : { label: "Launch & SEO", icon: <Rocket />, to: "/seo" };

  async function run(from?: StepKey) {
    setRerunOpen(false);
    await api(`/api/leads/${lead!.id}/run`, { method: "POST", json: from ? { from } : {} });
    void reload();
    reloadAll();
  }

  async function stop() {
    await api(`/api/leads/${lead!.id}/stop`, { method: "POST" });
    void reload();
    reloadAll();
  }

  async function winLead(regenerate = false) {
    pitchInit.current = true;
    setPitchErr(null);
    setCopied(false);
    // Show the draft cached after the gate straight away; only call the AI on first draft or regenerate.
    if (!regenerate && (pitch || lead!.outreach)) { setPitch(pitch ?? lead!.outreach); setPitchBusy(false); return; }
    setPitchBusy(true);
    if (regenerate) setPitch(null);
    try {
      const r = await api<{ subject: string; body: string }>(`/api/pitch/${lead!.id}`, { method: "POST", json: {} });
      setPitch(r);
    } catch (e) {
      setPitchErr((e as Error).message);
    } finally {
      setPitchBusy(false);
    }
  }

  async function openPlaybook(regenerate = false) {
    setPlayErr(null);
    if (!regenerate && (play || lead!.playbook)) { setPlay(play ?? lead!.playbook); setPlayBusy(false); return; }
    setPlayBusy(true);
    if (regenerate) setPlay(null);
    try {
      const r = await api<Detail["playbook"]>(`/api/playbook/${lead!.id}`, { method: "POST", json: {} });
      setPlay(r);
    } catch (e) {
      setPlayErr((e as Error).message);
    } finally {
      setPlayBusy(false);
    }
  }

  async function publish(unpublish = false) {
    setPubBusy(true);
    setPubErr(null);
    try {
      await api(`/api/leads/${lead!.id}/publish`, { method: unpublish ? "DELETE" : "POST", json: {} });
      void reload();
      reloadAll();
    } catch (e) {
      setPubErr((e as Error).message);
    } finally {
      setPubBusy(false);
    }
  }

  async function copyPitch() {
    if (!pitch) return;
    try {
      await navigator.clipboard.writeText(`Subject: ${pitch.subject}\n\n${pitch.body}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked: the textarea is there to copy by hand */ }
  }

  const mailtoHref = pitch
    ? `mailto:${lead.email || ""}?subject=${encodeURIComponent(pitch.subject)}&body=${encodeURIComponent(pitch.body)}`
    : "";

  // The published live link, and whether it's already in the email body (so we can warn before sending).
  const liveUrl = lead.publish?.url ? (/^https?:\/\//i.test(lead.publish.url) ? lead.publish.url : `https://${lead.publish.url}`) : "";
  const linkMissing = Boolean(liveUrl && pitch && !pitch.body.includes(lead.publish!.url) && !pitch.body.includes(liveUrl));

  function insertLiveLink() {
    if (!pitch || !liveUrl) return;
    setPitch({ ...pitch, body: `${pitch.body.trimEnd()}\n\nYou can see the new homepage here: ${liveUrl}` });
  }

  // Keep the Notes card in sync after a contact is logged, but never clobber unsaved edits.
  function syncNotes(next?: string) {
    if (next !== undefined && notes === savedNotes) { setNotes(next); setSavedNotes(next); }
    void reload();
  }

  async function sendEmail(test = false) {
    if (!pitch || (!test && !lead!.email)) return;
    if (!test && linkMissing && !confirm("The live mockup link isn't in the email. Send without it?")) return;
    const busy = test ? setTesting : setSending;
    busy(true);
    setSendErr(null);
    if (test) setTestSent(false); else setSent(false);
    try {
      const r = await api<{ notes?: string }>(`/api/leads/${lead!.id}/send-email`, { method: "POST", json: { subject: pitch.subject, body: pitch.body, attachMockup, test } });
      if (test) { setTestSent(true); setTimeout(() => setTestSent(false), 4000); }
      else { setSent(true); setTimeout(() => setSent(false), 4000); syncNotes(r.notes); }
    } catch (e) {
      setSendErr((e as Error).message);
    } finally {
      busy(false);
    }
  }

  async function recordContact(channel: "whatsapp" | "call") {
    try {
      const r = await api<{ notes?: string }>(`/api/leads/${lead!.id}/contacted`, { method: "POST", json: { channel } });
      syncNotes(r.notes);
    } catch { /* logging contact is best-effort; opening WhatsApp/the dialer still happens */ }
  }

  // WhatsApp deep link: wa.me needs digits only (strips spaces, dashes and a leading +).
  const waDigits = (lead.phone || "").replace(/[^\d]/g, "");
  const waHref = waDigits ? `https://wa.me/${waDigits}?text=${encodeURIComponent(waText)}` : "";

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
          {lead.hasMockup && workspaceEnabled("builds") && <Link className="btn btn-ink" to={`/builds/new?lead=${lead.id}`}><Blocks />Start build</Link>}
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

      <nav className="tabs" aria-label="Lead sections" style={{ marginTop: 4 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`tab tab-btn${tab === t.key ? " on" : ""}`}
            onClick={() => { setTab(t.key); if (t.key === "close") void openPlaybook(); if (t.key === "outreach" && !pitchInit.current) void winLead(); }}
          >{t.icon}{t.label}</button>
        ))}
      </nav>

      <div className="grid-main">
        <div className="stack">
          {tab === "overview" && (<>
            {/* Key numbers at a glance */}
            <div className="scores">
              <div className="score"><b>{doneSteps.length}/{STEPS.length}</b><span>Steps completed</span></div>
              <div className="score"><b className={gateCls}>{lead.gate ? `${gatePass}/${gateTotal}` : "—"}</b><span>Quality checks passed</span></div>
              <div className="score"><b className={scoreCls}>{lead.score ?? "—"}</b><span>Lead score{lead.temp ? ` · ${LEAD_TEMP[lead.temp].label}` : ""}</span></div>
              <div className="score"><b>{lead.rating ? `${lead.rating}/10` : "—"}</b><span>Your rating</span></div>
            </div>

            <div className="two">
              {/* Live mockup preview */}
              <div className="card">
                <div className="card-head">
                  <h3 className="card-title" style={{ fontSize: 18 }}><PanelsTopLeft size={18} /> Mockup preview</h3>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="icon-btn" aria-label="Open the redesign review" title="Open in Redesign" onClick={() => setTab("redesign")}><Monitor /></button>
                    <a className="icon-btn" aria-label="Open mockup full screen" title="Open full screen" href={fileUrl(lead.id, "mockup/index.html")} target="_blank" rel="noreferrer" style={!lead.hasMockup ? { pointerEvents: "none", opacity: .4 } : undefined}><ArrowUpRight /></a>
                  </div>
                </div>
                <div style={{ marginTop: 14 }}>
                  <Viewport view="desktop" height={360}>
                    {(s) =>
                      lead.hasMockup ? (
                        <div className="scale-wrap" style={{ ["--s" as string]: s }}><iframe title="Mockup preview" src={mockupSrc} sandbox="allow-scripts" /></div>
                      ) : (
                        <Empty icon={<Clock />} text={busy ? "Claude is building the mockup…" : "The mockup appears here once it's generated."} />
                      )
                    }
                  </Viewport>
                </div>
              </div>

              {/* Lead summary */}
              <div className="card">
                <div className="card-head">
                  <h3 className="card-title" style={{ fontSize: 18 }}><Info size={18} /> At a glance</h3>
                  <div style={{ display: "flex", gap: 8 }}>
                    {busy && <button className="btn btn-white btn-sm danger" onClick={() => void stop()} title="Stop this run"><X />Stop</button>}
                    <button className="btn btn-ink btn-sm" onClick={() => run()} disabled={busy || !next}>{busy ? "Running" : next ? "Run now" : "Done"} <ArrowRight /></button>
                  </div>
                </div>
                <dl className="fields">
                  <div className="field"><dt>Status</dt><dd><StatusPill status={lead.status} /></dd></div>
                  <div className="field"><dt>Current step</dt><dd>{next ? stepMeta(next.key).label : lead.gate?.pass ? "Done — passed every check" : "All steps complete"}</dd></div>
                  <div className="field"><dt>Vertical</dt><dd>{lead.benchmarks?.label ?? "Unclassified"}{lead.benchmarks ? ` · ${lead.benchmarks.sites.length} benchmarks` : ""}</dd></div>
                  <div className="field"><dt>Source</dt><dd>{sourceLabel}</dd></div>
                  <div className="field"><dt>Email</dt><dd>{lead.email ? <a href={`mailto:${lead.email}`}>{lead.email}</a> : "—"}</dd></div>
                  <div className="field"><dt>Phone</dt><dd>{lead.phone || "—"}</dd></div>
                  <div className="field"><dt>Website</dt><dd>{scratch ? "No website · Google listing" : <a href={lead.url} target="_blank" rel="noreferrer">{host(lead.url)}</a>}</dd></div>
                  <div className="field"><dt>Added</dt><dd>{shortDate(lead.createdAt)} · {timeAgo(lead.createdAt)}</dd></div>
                  {lead.lastContactedAt && <div className="field"><dt>Last contacted</dt><dd>{timeAgo(lead.lastContactedAt)}</dd></div>}
                </dl>
                {swatches.length > 0 && (
                  <div className="brand-row" style={{ marginTop: 16 }}>
                    <span className="label-sm" style={{ margin: "0 2px 0 0" }}>Brand</span>
                    {swatches.map((c) => <span key={c} className="swatch"><i style={{ background: c }} />{c}</span>)}
                  </div>
                )}
              </div>
            </div>

            <div className={workspaceEnabled("builds") ? "two" : ""}>
              {workspaceEnabled("builds") && (
                <div className="card">
                  <h3 className="card-title" style={{ fontSize: 18 }}><Rocket size={18} /> Delivery pipeline</h3>
                  <p className="card-sub" style={{ margin: "2px 0 12px" }}>Move this lead to the next stage with one click.</p>
                  <div className="steps">
                    {stageList.map((s, i) => {
                      const prevDone = i === 0 || stageList[i - 1].done;
                      const state = s.done ? "done" : s.started ? "running" : prevDone ? "next" : "pending";
                      return (
                        <div key={s.key} className={`step${state === "running" ? " running" : ""}`}>
                          <div><b>{s.label}</b><span>{state === "done" ? "Done" : state === "running" ? "In progress" : state === "next" ? "Up next" : "Not started"}</span></div>
                          <span className="ico">
                            {s.done ? <CheckCircle2 className="ok" /> : s.started ? <Loader2 className="spin" /> : <span className="dot" style={{ opacity: state === "next" ? 1 : .3 }} />}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ marginTop: 14 }}>
                    {nextStep.to ? (
                      <Link className="btn btn-ink btn-sm" style={{ width: "100%", justifyContent: "center" }} to={nextStep.to}>{nextStep.icon}{nextStep.label}<ArrowRight /></Link>
                    ) : (
                      <button className="btn btn-ink btn-sm" style={{ width: "100%", justifyContent: "center" }} onClick={nextStep.onClick} disabled={nextStep.disabled || advBusy}>
                        {advBusy ? <Loader2 className="spin" /> : nextStep.icon}{nextStep.label}{!nextStep.disabled && <ArrowRight />}
                      </button>
                    )}
                  </div>
                  {(pipe.build || pipe.conversion) && (
                    <div className="notif-foot" style={{ marginTop: 10 }}>
                      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                        {pipe.build && <Link className="link-btn" to={`/builds/${pipe.build.id}`}><Blocks size={14} />Open build</Link>}
                        {pipe.conversion && <Link className="link-btn" to={`/wp/${pipe.conversion.id}`}><PanelsTopLeft size={14} />Open WordPress</Link>}
                        {buildReady && <Link className="link-btn" to="/care"><Wrench size={14} />Maintenance</Link>}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="card">
                <h3 className="card-title" style={{ fontSize: 18 }}>Form entries <ArrowUpRight size={20} strokeWidth={1.6} /></h3>
                <p className="card-sub">Submitted via {sourceLabel} · {timeAgo(lead.createdAt)}</p>
                <dl className="fields">
                  {Object.entries(lead.fields).map(([k, v]) => (
                    <div key={k} className="field"><dt>{k}</dt><dd>{v || "—"}</dd></div>
                  ))}
                </dl>
                <div style={{ marginTop: 14 }}><StatusPill status={lead.status} /></div>
              </div>
            </div>

            {(lead.diagnosis?.issues?.length || next) && (
              <div className="card card-lg">
                <div className="guide">
                  <h5>{lead.diagnosis?.issues?.length ? `Top issues on ${scratch ? "their listing" : host(lead.url)}` : "What's next"}</h5>
                  <ul>
                    {(lead.diagnosis?.issues ?? []).slice(0, 4).map((i, n) => (
                      <li key={n}><span className={`sev ${i.severity}`} /><div>{i.title}<small>{i.detail}</small></div></li>
                    ))}
                    {!lead.diagnosis?.issues?.length && next && (
                      <li><ArrowRight className="muted" /><div>{stepMeta(next.key).label}<small>{next.note || stepMeta(next.key).hint}</small></div></li>
                    )}
                  </ul>
                </div>
              </div>
            )}

            <div className="bottom-actions">
              <a className="btn btn-outline" href={lead.url} target="_blank" rel="noreferrer">{scratch ? "Open Google listing" : "Open current site"}</a>
              <a className="btn btn-accent" href={fileUrl(lead.id, "mockup/index.html")} target="_blank" rel="noreferrer" style={!lead.hasMockup ? { pointerEvents: "none", opacity: .5 } : undefined}>Open mockup full screen</a>
            </div>
          </>)}

          {tab === "redesign" && (<>
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
                  <div><b>{scratch ? "Today: Google Maps only" : "Current site"}</b><span>{scratch ? "No website · their listing" : `${host(lead.url)} · ${live ? "live" : "screenshot"}`}</span></div>
                  <div className="pane-tools">
                    {!scratch && <button className="icon-btn" aria-label={live ? "Show screenshot" : "Try live page"} title={live ? "Show screenshot" : "Try live page"} onClick={() => setLive(!live)}>{live ? <ImageIcon /> : <RefreshCw />}</button>}
                    <a className="icon-btn" aria-label={scratch ? "Open Google Maps listing" : "Open current site"} href={lead.url} target="_blank" rel="noreferrer"><ArrowUpRight /></a>
                  </div>
                </div>
                <Viewport view={view}>
                  {(s) =>
                    live && !scratch ? (
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
            )}

            <div className="bottom-actions">
              <a className="btn btn-outline" href={lead.url} target="_blank" rel="noreferrer">{scratch ? "Open Google listing" : "Open current site"}</a>
              <a className="btn btn-accent" href={fileUrl(lead.id, "mockup/index.html")} target="_blank" rel="noreferrer" style={!lead.hasMockup ? { pointerEvents: "none", opacity: .5 } : undefined}>Open mockup full screen</a>
            </div>
          </div>
          </>)}

          {tab === "outreach" && (<>
            {/* Email */}
            <div className="card card-lg stack" style={{ gap: 18 }}>
              <div className="card-head">
                <div>
                  <h2 className="section-title">Email {name}</h2>
                  <p className="card-sub" style={{ margin: "4px 0 0" }}>
                    {lead.email ? <>Sending to <b>{lead.email}</b>. </> : "No email address on this lead — use WhatsApp below, or add one via the form. "}
                    A closing email built from this lead's answers, the issues found and the new mockup. Edit anything before you send.
                  </p>
                </div>
                <button type="button" className="btn btn-white btn-sm" onClick={() => winLead(true)} disabled={pitchBusy}>
                  {pitchBusy ? <Loader2 className="spin" /> : <RefreshCw />}Regenerate
                </button>
              </div>

              {pitchBusy && !pitch && <div className="pitch-loading"><Loader2 className="spin" /><span>Writing the email…</span></div>}
              {pitchErr && !pitchBusy && <div className="banner err" style={{ margin: 0 }}><XCircle /><div>{pitchErr}</div></div>}

              {pitch && (<>
                <label className="pitch-field">
                  <span>Subject</span>
                  <input className="input" value={pitch.subject} onChange={(e) => setPitch({ ...pitch, subject: e.target.value })} />
                </label>
                <label className="pitch-field">
                  <span>Email</span>
                  <textarea className="input pitch-body" rows={14} value={pitch.body} onChange={(e) => setPitch({ ...pitch, body: e.target.value })} />
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "var(--text-2)" }}>
                  <input type="checkbox" checked={attachMockup} onChange={(e) => setAttachMockup(e.target.checked)} disabled={!lead.hasMockup} />
                  Attach a preview image of the mockup{!lead.hasMockup && " (available once the mockup is ready)"}
                </label>

                {linkMissing && (
                  <div className="banner">
                    <Info />
                    <div>The live mockup link isn't in this email. <button type="button" className="link-btn" style={{ display: "inline" }} onClick={insertLiveLink}>Add it</button></div>
                  </div>
                )}
                {sendErr && <div className="banner err" style={{ margin: 0 }}><XCircle /><div>{sendErr}</div></div>}
                {sent && <div className="banner"><CheckCircle2 className="ok" /><div>Email sent to {lead.email}.</div></div>}
                {testSent && <div className="banner"><CheckCircle2 className="ok" /><div>Test sent to your own address.</div></div>}
                {!lead.emailReady && (
                  <p className="card-sub" style={{ margin: 0 }}>
                    To send directly from the app, set up your outreach mailbox in <Link to="/settings/integrations">Settings → Integrations</Link>. You can still copy the text or open it in your own email app.
                  </p>
                )}

                <div className="bottom-actions" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
                  <button type="button" className="btn btn-white" onClick={() => void copyPitch()}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}</button>
                  <a className="btn btn-white" href={mailtoHref} style={!lead.email ? { pointerEvents: "none", opacity: .5 } : undefined}><Mail />Open in email app</a>
                  <button type="button" className="btn btn-white" onClick={() => void sendEmail(true)} disabled={testing || !lead.emailReady} title={!lead.emailReady ? "Set up your outreach mailbox first" : "Send a copy to your own address"}>
                    {testing ? <Loader2 className="spin" /> : <Send />}{testing ? "Sending…" : "Send test to me"}
                  </button>
                  <button type="button" className="btn btn-accent" onClick={() => void sendEmail()} disabled={sending || !lead.email || !lead.emailReady} title={!lead.emailReady ? "Set up your outreach mailbox in Settings → Integrations" : undefined}>
                    {sending ? <Loader2 className="spin" /> : <Send />}{sending ? "Sending…" : "Send email"}
                  </button>
                </div>
              </>)}
            </div>

            {/* WhatsApp */}
            <div className="card card-lg stack" style={{ gap: 14 }}>
              <div>
                <h2 className="section-title">WhatsApp</h2>
                <p className="card-sub" style={{ margin: "4px 0 0" }}>
                  {lead.phone ? <>Message <b>{lead.phone}</b> on WhatsApp. </> : "No phone number on this lead. "}
                  Edit the text, then open WhatsApp with it prefilled to send.
                </p>
              </div>
              <textarea className="input" rows={4} value={waText} onChange={(e) => setWaText(e.target.value)} placeholder="Your WhatsApp message…" />
              <div className="bottom-actions">
                <a className="btn btn-outline" href={`tel:${(lead.phone || "").replace(/[^\d+]/g, "")}`} onClick={() => void recordContact("call")} style={!lead.phone ? { pointerEvents: "none", opacity: .5 } : undefined}>Call {lead.phone || ""}</a>
                <a className="btn btn-accent" href={waHref || undefined} target="_blank" rel="noreferrer" onClick={() => void recordContact("whatsapp")} style={!waHref ? { pointerEvents: "none", opacity: .5 } : undefined}><MessageCircle />Open in WhatsApp</a>
              </div>
            </div>
          </>)}

          {tab === "seo" && (
            <div className="card card-lg stack" style={{ gap: 24 }}>
              <div>
                <h2 className="section-title">SEO audit</h2>
                <p className="card-sub" style={{ margin: "4px 0 0" }}>Lighthouse scores and the issues found on {scratch ? "their Google listing" : host(lead.url)}.</p>
              </div>
              {lead.diagnosis?.lighthouse && (
                <div className="scores">
                  {([["Performance", "performance"], ["Accessibility", "accessibility"], ["Best practices", "bestPractices"], ["SEO", "seo"]] as const).map(([l, k]) => {
                    const v = lead.diagnosis!.lighthouse![k];
                    return <div key={k} className="score"><b className={v >= 90 ? "ok" : v >= 50 ? "warn" : "bad"}>{v}</b><span>{l} (current site)</span></div>;
                  })}
                </div>
              )}
              <div className="guide">
                <h5>{scratch ? "Why they need a site" : "Issues found on the current site"}</h5>
                <ul>
                  {(lead.diagnosis?.issues ?? []).map((i, n) => (
                    <li key={n}><span className={`sev ${i.severity}`} /><div>{i.title}<small>{i.detail}</small></div></li>
                  ))}
                  {!lead.diagnosis && <li><Info className="muted" /><div className="muted">Diagnosis is still running.</div></li>}
                  {lead.diagnosis && !lead.diagnosis.issues.length && <li><CheckCircle2 className="ok" /><div className="muted">No issues flagged.</div></li>}
                </ul>
              </div>
            </div>
          )}

          {tab === "competitors" && (
            <div className="card card-lg stack" style={{ gap: 20 }}>
              <div>
                <h2 className="section-title">Competitors</h2>
                <p className="card-sub" style={{ margin: "4px 0 0" }}>
                  {lead.benchmarks ? `Benchmark set for ${lead.benchmarks.label} — the sites buyers compare against. ${lead.benchmarks.register}` : "Benchmarks are picked once the lead is classified."}
                </p>
              </div>
              {lead.benchmarks ? (
                <ul className="ref-list">
                  {lead.benchmarks.sites.map((s) => (
                    <li key={s.url}>
                      <a href={s.url} target="_blank" rel="noreferrer" title={s.why}>
                        <span className="ref-name">{s.name}</span>
                        <span className="ref-host">{host(s.url)} · {s.why}</span>
                        <ArrowUpRight />
                      </a>
                    </li>
                  ))}
                  {!lead.benchmarks.sites.length && <li className="muted" style={{ padding: 10 }}>No benchmark sites recorded.</li>}
                </ul>
              ) : (
                <Empty icon={<Users />} text="No benchmarks yet. They're chosen when the lead is classified into a vertical." />
              )}
            </div>
          )}

          {tab === "close" && (
            <div className="card card-lg stack" style={{ gap: 18 }}>
              <div className="card-head">
                <div>
                  <h2 className="section-title">How to close {name}</h2>
                  <p className="card-sub" style={{ margin: "4px 0 0" }}>A strategy brief — the angle, their pain points, likely objections, pricing and the next step. This is not the email.</p>
                </div>
                <button type="button" className="btn btn-white btn-sm" onClick={() => void openPlaybook(true)} disabled={playBusy}>
                  {playBusy ? <Loader2 className="spin" /> : <RefreshCw />}Regenerate
                </button>
              </div>
              {playBusy && !play && <div className="pitch-loading"><Loader2 className="spin" /><span>Working out the play…</span></div>}
              {playErr && !playBusy && <div className="banner err" style={{ margin: 0 }}><XCircle /><div>{playErr}</div></div>}
              {play && <div className="playbook"><p className="playbook-text">{play.text.replace(/\*\*/g, "").replace(/^#+\s*/gm, "")}</p></div>}
              <div className="bottom-actions">
                <button className="btn btn-outline" onClick={() => { setTab("outreach"); if (!pitchInit.current) void winLead(); }}><Mail />Outreach email</button>
                <a className="btn btn-accent" href={fileUrl(lead.id, "mockup/index.html")} target="_blank" rel="noreferrer" style={!lead.hasMockup ? { pointerEvents: "none", opacity: .5 } : undefined}>Open mockup full screen</a>
              </div>
            </div>
          )}
        </div>

        {/* Right column */}
        <div className="stack side-col">
          {lead.hasMockup && (
            <div className="card publish-card">
              <div className="card-head">
                <h3 className="card-title"><Globe size={18} /> Live mockup</h3>
                {lead.publish && <span className="dot-live" title="Published" />}
              </div>
              {lead.publish ? (
                <>
                  <a className="live-url" href={/^https?:\/\//i.test(lead.publish.url) ? lead.publish.url : `https://${lead.publish.url}`} target="_blank" rel="noreferrer">{lead.publish.url}<ArrowUpRight size={14} /></a>
                  <p className="card-sub" style={{ margin: 0 }}>Published {timeAgo(lead.publish.at)}. This link is used in the outreach email.</p>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button className="btn btn-white btn-sm" onClick={() => void publish(false)} disabled={pubBusy}>{pubBusy ? <Loader2 className="spin" /> : <RefreshCw />}Update</button>
                    <button className="btn btn-white btn-sm danger" onClick={() => void publish(true)} disabled={pubBusy}><Trash2 />Unpublish</button>
                  </div>
                </>
              ) : (
                <>
                  <p className="card-sub" style={{ margin: 0 }}>
                    {lead.publishReady ? "Publish this mockup to your Hostinger subdomain so you can send a real link." : "Add your Hostinger SFTP details in Settings → Integrations to publish mockups live."}
                  </p>
                  <button className="btn btn-ink btn-sm" style={{ width: "100%", justifyContent: "center" }} onClick={() => void publish(false)} disabled={pubBusy || !lead.publishReady}>
                    {pubBusy ? <Loader2 className="spin" /> : <Globe />}Publish live
                  </button>
                </>
              )}
              {pubErr && <div className="banner err" style={{ margin: 0 }}><XCircle />{pubErr}</div>}
            </div>
          )}

          {lead.hasMockup && (
            <div className="card rate-card">
              <div className="card-head">
                <h3 className="card-title"><Star size={18} /> Rate this mockup</h3>
                {savedNote && <span className="muted" style={{ fontSize: 12 }}><Check size={13} /> Saved</span>}
              </div>
              <div className="rate-scale" role="radiogroup" aria-label="Rating out of 10">
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    role="radio"
                    aria-checked={rating === n}
                    className={`rate-dot${rating !== undefined && n <= rating ? " on" : ""}`}
                    onClick={() => { setRating(n); void saveFeedback({ rating: n }); }}
                  >{n}</button>
                ))}
              </div>
              <textarea
                className="input"
                rows={3}
                placeholder="What works, what doesn't? This feedback is saved and used to improve future mockups."
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                onBlur={() => { if (feedback !== (lead.feedback ?? "")) void saveFeedback({ feedback }); }}
              />
              <button className="btn btn-ink btn-sm" style={{ width: "100%", justifyContent: "center" }} onClick={() => { setReviseErr(null); setReviseOpen(true); }} disabled={busy}>
                <Wand2 />Request changes
              </button>
            </div>
          )}

          <div className="card">
            <div className="card-head">
              <h3 className="card-title"><StickyNote size={18} /> Notes</h3>
              {notesSaved && <span className="muted" style={{ fontSize: 12 }}><Check size={13} /> Saved</span>}
            </div>
            <p className="card-sub" style={{ margin: "2px 0 8px" }}>Track where this lead stands — contacted, follow-ups, what you've sent.</p>
            <textarea
              className="input"
              rows={4}
              placeholder="e.g. Called 7 Oct, sent the mockup link, follow up Friday…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <button className="btn btn-ink btn-sm" style={{ width: "100%", justifyContent: "center", marginTop: 10 }} disabled={notes === savedNotes} onClick={() => void saveNotes()}>Save notes</button>
          </div>

          <div className="card">
            <div className="card-head">
              <h3 className="card-title">Mockup steps</h3>
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

      {reviseOpen && (
        <div className="backdrop" onClick={() => !reviseBusy && setReviseOpen(false)}>
          <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Request changes">
            <div className="card-head">
              <div>
                <h3 className="card-title" style={{ fontSize: 22 }}>Request changes to {name}</h3>
                <p className="card-sub" style={{ margin: "2px 0 0" }}>Describe what to change. The mockup is regenerated with your request applied, then re-checked.</p>
              </div>
              <button type="button" className="icon-btn" aria-label="Close" onClick={() => setReviseOpen(false)} disabled={reviseBusy}><X /></button>
            </div>
            <textarea
              className="input"
              rows={6}
              autoFocus
              placeholder="e.g. Make the hero headline bigger, move the testimonials above the services, and use a warmer background."
              value={reviseText}
              onChange={(e) => setReviseText(e.target.value)}
            />
            {reviseErr && <div className="banner err" style={{ margin: 0 }}><XCircle /><div>{reviseErr}</div></div>}
            <div className="foot" style={{ justifyContent: "flex-end", gap: 12 }}>
              <button type="button" className="btn btn-white" onClick={() => setReviseOpen(false)} disabled={reviseBusy}>Cancel</button>
              <button type="button" className="btn btn-ink" onClick={() => void submitRevise()} disabled={reviseBusy || !reviseText.trim()}>
                {reviseBusy ? <Loader2 className="spin" /> : <Wand2 />}Apply changes
              </button>
            </div>
          </div>
        </div>
      )}

    </>
  );
}
