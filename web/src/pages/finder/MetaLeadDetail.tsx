import { useNavigate, useOutletContext, useParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { ArrowLeft, Sparkles, Trash2 } from "lucide-react";
import type { Lead, MetaLead, MetaLeadStatus } from "../../../../shared/types";
import { META_LEAD_STATUS } from "../../../../shared/types";
import { api, shortDate } from "../../lib/api";
import type { LayoutCtx } from "../../layout/Layout";
import { MetaStatusPill } from "./MetaLeads";

const SOURCE_LABEL: Record<MetaLead["source"], string> = { facebook: "Facebook/Instagram lead ad", csv: "Imported from CSV", manual: "Added by hand" };

export default function MetaLeadDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { reloadAll } = useOutletContext<LayoutCtx>();
  const [lead, setLead] = useState<(MetaLead & { mockup: Lead | null }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [savedNotes, setSavedNotes] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    try {
      const l = await api<MetaLead & { mockup: Lead | null }>(`/api/meta/leads/${id}`);
      setLead(l);
      setNotes(l.notes);
      setSavedNotes(l.notes);
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
  };
  const setStatus = (status: MetaLeadStatus) => void patch({ status });
  const saveNotes = async () => { await patch({ notes }); setSavedNotes(notes); };

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

      <div className="grid-2" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, alignItems: "start" }}>
        <div className="card">
          <h3 className="card-title">Contact</h3>
          <dl className="fields">
            <div className="field"><dt>Name</dt><dd>{lead.name || <span className="muted">—</span>}</dd></div>
            <div className="field"><dt>Email</dt><dd>{lead.email ? <a className="ext-link" href={`mailto:${lead.email}`}>{lead.email}</a> : <span className="muted">—</span>}</dd></div>
            <div className="field"><dt>Phone</dt><dd>{lead.phone ? <a className="ext-link" href={`tel:${lead.phone}`}>{lead.phone}</a> : <span className="muted">—</span>}</dd></div>
            <div className="field"><dt>Company</dt><dd>{lead.company || <span className="muted">—</span>}</dd></div>
          </dl>
        </div>

        <div className="card">
          <h3 className="card-title">Source</h3>
          <dl className="fields">
            <div className="field"><dt>From</dt><dd>{SOURCE_LABEL[lead.source]}</dd></div>
            {lead.platform && <div className="field"><dt>Platform</dt><dd>{lead.platform}</dd></div>}
            {lead.campaign && <div className="field"><dt>Campaign</dt><dd>{lead.campaign}</dd></div>}
            {lead.adName && <div className="field"><dt>Ad</dt><dd>{lead.adName}</dd></div>}
            {lead.formName && <div className="field"><dt>Form</dt><dd>{lead.formName}</dd></div>}
            <div className="field"><dt>Received</dt><dd>{shortDate(lead.submittedAt ?? lead.createdAt)}</dd></div>
          </dl>
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
