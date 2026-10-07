import { useNavigate, useOutletContext, useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import {
  ArrowLeft, BellRing, Check, FileText, Globe, MessageSquare, Phone, Plus, Send, Sparkles, Star, Tag, Trash2, X,
} from "lucide-react";
import type { Lead, MetaActivity, MetaActivityKind, MetaLead, MetaLeadStatus } from "../../../../shared/types";
import { META_ACTIVITY, META_LEAD_STATUS, META_TAG, PREMIUM_TAG } from "../../../../shared/types";
import { api, shortDate, timeAgo } from "../../lib/api";
import type { LayoutCtx } from "../../layout/Layout";
import { MetaStatusPill, followUpState } from "./MetaLeads";

const SOURCE_LABEL: Record<MetaLead["source"], string> = { facebook: "Facebook/Instagram lead ad", csv: "Imported from CSV", manual: "Added by hand" };
const ACTIVITY_LABEL = Object.fromEntries(META_ACTIVITY.map((a) => [a.key, a.label])) as Record<MetaActivityKind, string>;
const ACTIVITY_ICON: Record<MetaActivityKind, typeof Phone> = {
  contacted: Phone, follow_up: BellRing, mockup_created: Sparkles, mockup_sent: Send, proposal_sent: FileText, note: MessageSquare, status: Check,
};

export default function MetaLeadDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { reloadAll } = useOutletContext<LayoutCtx>();
  const [lead, setLead] = useState<(MetaLead & { mockup: Lead | null }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [savedNotes, setSavedNotes] = useState("");
  const [website, setWebsite] = useState("");
  const [savedWebsite, setSavedWebsite] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [detail, setDetail] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actBusy, setActBusy] = useState(false);

  const load = async () => {
    try {
      const l = await api<MetaLead & { mockup: Lead | null }>(`/api/meta/leads/${id}`);
      setLead(l);
      setNotes(l.notes);
      setSavedNotes(l.notes);
      setWebsite(l.website ?? "");
      setSavedWebsite(l.website ?? "");
      setDue(l.followUpAt ? l.followUpAt.slice(0, 10) : "");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => { void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="empty"><h4>Couldn't load this lead</h4><p>{error}</p></div>;
  if (!lead) return <div className="empty"><p>Loading…</p></div>;

  const patch = async (body: Partial<MetaLead>) => {
    const l = await api<MetaLead>(`/api/meta/leads/${id}`, { method: "PATCH", json: body });
    setLead({ ...lead, ...l });
    reloadAll();
    return l;
  };
  const setStatus = (status: MetaLeadStatus) => void patch({ status });
  const saveNotes = async () => { await patch({ notes }); setSavedNotes(notes); };
  const saveWebsite = async () => { await patch({ website }); setSavedWebsite(website); };

  const labels = lead.labels ?? [];
  const toggleLabel = (tag: string) => {
    const has = labels.some((l) => l.toLowerCase() === tag.toLowerCase());
    void patch({ labels: has ? labels.filter((l) => l.toLowerCase() !== tag.toLowerCase()) : [...labels, tag] });
  };
  const addLabel = () => {
    const tag = newLabel.trim();
    if (!tag || labels.some((l) => l.toLowerCase() === tag.toLowerCase())) { setNewLabel(""); return; }
    void patch({ labels: [...labels, tag] });
    setNewLabel("");
  };
  const removeLabel = (tag: string) => void patch({ labels: labels.filter((l) => l !== tag) });

  const addActivity = async (body: { kind: MetaActivityKind; text?: string; dueAt?: string }) => {
    setActBusy(true);
    try {
      const l = await api<MetaLead>(`/api/meta/leads/${id}/activity`, { method: "POST", json: body });
      setLead({ ...lead, ...l });
      reloadAll();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setActBusy(false);
    }
  };
  const logAction = async (kind: MetaActivityKind) => { await addActivity({ kind, text: detail.trim() || undefined }); setDetail(""); };
  const scheduleFollowUp = async () => { if (!due) return; await addActivity({ kind: "follow_up", text: detail.trim() || undefined, dueAt: due }); setDetail(""); };
  const clearFollowUp = async () => {
    setActBusy(true);
    try {
      const l = await api<MetaLead>(`/api/meta/leads/${id}/activity/clear-followup`, { method: "POST", json: {} });
      setLead({ ...lead, ...l });
      setDue("");
      reloadAll();
    } finally { setActBusy(false); }
  };

  const createMockup = async () => {
    setBusy("Starting mockup…");
    try {
      const r = await api<{ leadId: string }>(`/api/meta/leads/${id}/mockup`, { method: "POST", json: {} });
      await load();
      reloadAll();
      if (confirm("Mockup started in the Mockups workspace. Open it now?")) nav(`/leads/${r.leadId}`);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!confirm("Delete this lead? This can't be undone.")) return;
    await api(`/api/meta/leads/${id}`, { method: "DELETE" });
    reloadAll();
    nav("/finder/meta");
  };

  const answers = Object.entries(lead.fields);
  const activity = lead.activity ?? [];
  const extraLabels = labels.filter((l) => l.toLowerCase() !== META_TAG.toLowerCase() && l.toLowerCase() !== PREMIUM_TAG.toLowerCase());
  const isPremium = labels.some((l) => l.toLowerCase() === PREMIUM_TAG.toLowerCase());
  const chip = (bg: string): React.CSSProperties => ({ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 999, fontSize: 13, background: bg, color: "var(--text)" });
  const fu = followUpState(lead);

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <span>Lead Finder</span><span className="sep">/</span>
        <button type="button" className="link-btn" onClick={() => nav("/finder/meta")}>Meta leads</button>
        <span className="sep">/</span><span className="here">{lead.name || lead.email || "Lead"}</span>
      </nav>

      <div className="title-row">
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <button type="button" className="btn btn-sm btn-icon btn-chip" aria-label="Back" onClick={() => nav("/finder/meta")}><ArrowLeft /></button>
          <h1 className="page-title" style={{ marginBottom: 0 }}>{lead.name || lead.email || lead.phone || "Unnamed lead"}</h1>
          <MetaStatusPill status={lead.status} />
        </div>
        <div className="actions">
          {lead.mockup ? (
            <button className="btn btn-white" onClick={() => nav(`/leads/${lead.mockup!.id}`)}><Sparkles />Open mockup</button>
          ) : (
            <button className="btn btn-white" onClick={() => void createMockup()} disabled={!!busy}><Sparkles />{busy ?? "Create mockup"}</button>
          )}
          <button className="btn btn-white danger" onClick={() => void remove()}><Trash2 />Delete</button>
        </div>
      </div>

      <div className="seg" role="group" aria-label="Set status" style={{ marginBottom: 16 }}>
        {META_LEAD_STATUS.map((s) => (
          <button key={s.key} className={lead.status === s.key ? "on" : ""} onClick={() => setStatus(s.key)}>{s.label}</button>
        ))}
      </div>

      {fu !== "none" && (
        <div className="banner" style={{ background: fu === "due" ? "var(--danger-soft, #fdecea)" : "var(--accent-softer)", color: "var(--text)", marginBottom: 16 }}>
          <BellRing />
          <span style={{ flex: 1 }}>{fu === "due" ? "Follow-up due" : "Follow-up scheduled"} — {shortDate(lead.followUpAt)}.</span>
          <button className="btn btn-sm btn-white" onClick={() => void clearFollowUp()} disabled={actBusy}><Check />Mark done</button>
        </div>
      )}

      <div className="grid-2" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, alignItems: "start" }}>
        <div className="card">
          <h3 className="card-title">Contact</h3>
          <dl className="fields">
            <div className="field"><dt>Name</dt><dd>{lead.name || <span className="muted">—</span>}</dd></div>
            <div className="field"><dt>Email</dt><dd>{lead.email ? <a className="ext-link" href={`mailto:${lead.email}`}>{lead.email}</a> : <span className="muted">—</span>}</dd></div>
            <div className="field"><dt>Phone</dt><dd>{lead.phone ? <a className="ext-link" href={`tel:${lead.phone}`}>{lead.phone}</a> : <span className="muted">—</span>}</dd></div>
            <div className="field"><dt>Company</dt><dd>{lead.company || <span className="muted">—</span>}</dd></div>
          </dl>
          <div className="input-group" style={{ marginTop: 12 }}>
            <label htmlFor="m-website"><Globe size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />Website</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input id="m-website" className="input" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="acmebakery.com" />
              <button className="btn btn-sm btn-ink" disabled={website.trim() === savedWebsite.trim()} onClick={() => void saveWebsite()}>Save</button>
            </div>
            <span className="hint">{lead.mockup ? "A mockup is linked below." : website.trim() ? "Ready — click “Create mockup” to start the pipeline." : "Add a website to turn this lead into a mockup."}</span>
          </div>
        </div>

        <div className="card">
          <h3 className="card-title">Source & tags</h3>
          <dl className="fields">
            <div className="field"><dt>From</dt><dd>{SOURCE_LABEL[lead.source]}</dd></div>
            {lead.platform && <div className="field"><dt>Platform</dt><dd>{lead.platform}</dd></div>}
            {lead.campaign && <div className="field"><dt>Campaign</dt><dd>{lead.campaign}</dd></div>}
            {lead.adName && <div className="field"><dt>Ad</dt><dd>{lead.adName}</dd></div>}
            {lead.formName && <div className="field"><dt>Form</dt><dd>{lead.formName}</dd></div>}
            <div className="field"><dt>Received</dt><dd>{shortDate(lead.submittedAt ?? lead.createdAt)}</dd></div>
          </dl>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
            <span style={chip("var(--accent-softer)")}><Tag size={13} />{META_TAG}</span>
            <button type="button" style={{ ...chip(isPremium ? "var(--accent-softer)" : "var(--surface-2, #f1f1f3)"), border: "1px solid var(--line)", cursor: "pointer", opacity: isPremium ? 1 : 0.7 }} onClick={() => toggleLabel(PREMIUM_TAG)}>
              <Star size={13} fill={isPremium ? "currentColor" : "none"} />{PREMIUM_TAG}
            </button>
            {extraLabels.map((t) => (
              <span key={t} style={chip("var(--surface-2, #f1f1f3)")}>{t}<button type="button" className="link-btn" aria-label={`Remove ${t}`} onClick={() => removeLabel(t)} style={{ display: "inline-flex" }}><X size={12} /></button></span>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <input className="input" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="Add a tag…" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLabel(); } }} />
            <button className="btn btn-sm btn-white" onClick={addLabel} disabled={!newLabel.trim()}><Plus />Add</button>
          </div>
        </div>

        <div className="card" style={{ gridColumn: "1 / -1" }}>
          <h3 className="card-title">Pipeline</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-start" }}>
            <input className="input" value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="What happened? (optional — e.g. left a voicemail)" style={{ flex: "1 1 260px" }} />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
            <button className="btn btn-sm btn-white" disabled={actBusy} onClick={() => void logAction("contacted")}><Phone />Log contact</button>
            <button className="btn btn-sm btn-white" disabled={actBusy} onClick={() => void logAction("mockup_sent")}><Send />Mockup sent</button>
            <button className="btn btn-sm btn-white" disabled={actBusy} onClick={() => void logAction("proposal_sent")}><FileText />Proposal sent</button>
            <button className="btn btn-sm btn-white" disabled={actBusy || !detail.trim()} onClick={() => void logAction("note")}><MessageSquare />Add note</button>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
              <input type="date" className="input" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Follow-up date" style={{ width: "auto" }} />
              <button className="btn btn-sm btn-ink" disabled={actBusy || !due} onClick={() => void scheduleFollowUp()}><BellRing />Set follow-up</button>
            </span>
          </div>

          <div style={{ marginTop: 16 }}>
            {activity.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>No activity yet. Log your first contact, schedule a follow-up, or mark the mockup as sent to start the timeline.</p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
                {activity.map((a: MetaActivity, i) => {
                  const Icon = ACTIVITY_ICON[a.kind] ?? MessageSquare;
                  return (
                    <li key={i} style={{ display: "flex", gap: 12 }}>
                      <span className="biz-mark" aria-hidden="true" style={{ flexShrink: 0 }}><Icon size={14} /></span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                          <b>{ACTIVITY_LABEL[a.kind] ?? a.kind}</b>
                          <span className="muted" style={{ fontSize: 12 }}>{timeAgo(a.at)}</span>
                          {a.kind === "follow_up" && a.dueAt && <span className="muted" style={{ fontSize: 12 }}>· due {shortDate(a.dueAt)}</span>}
                        </div>
                        {a.text && <div style={{ fontSize: 14 }}>{a.text}</div>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {answers.length > 0 && (
          <div className="card">
            <h3 className="card-title">Form answers</h3>
            <dl className="fields">
              {answers.map(([k, v]) => (<div className="field" key={k}><dt>{k}</dt><dd>{v}</dd></div>))}
            </dl>
          </div>
        )}

        <div className="card">
          <h3 className="card-title">Notes</h3>
          <textarea className="input" rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything worth remembering about this lead…" />
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
            <button className="btn btn-sm btn-ink" disabled={notes === savedNotes} onClick={() => void saveNotes()}>Save notes</button>
          </div>
        </div>
      </div>
    </>
  );
}
