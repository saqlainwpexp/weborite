import { useEffect, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import { ArrowRight, FileText, LayoutTemplate, PenLine, Sparkles, XCircle } from "lucide-react";
import type { Build } from "../../../../shared/types";
import type { LayoutCtx } from "../../layout/Layout";
import { api, fileUrl, host } from "../../lib/api";
import { Dropdown } from "../../components/Dropdown";
import { DEFAULT_PAGES, Field, PagesEditor, type PageDraft } from "../../components/builds";

/** New build (/builds/new?lead=…) and brief editing (/builds/:id/edit). */
export default function BuildForm() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { leads, builds, reloadAll } = useOutletContext<LayoutCtx>();
  const editing = builds?.find((b) => b.id === id) ?? null;

  const [leadId, setLeadId] = useState(params.get("lead") ?? "");
  const [changes, setChanges] = useState("");
  const [details, setDetails] = useState("");
  const [pages, setPages] = useState<PageDraft[]>(DEFAULT_PAGES);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!id);

  useEffect(() => {
    if (editing && !loaded) {
      setLeadId(editing.leadId);
      setChanges(editing.homepageChanges);
      setDetails(editing.details);
      setPages(editing.pages.map((p) => ({ title: p.title, brief: p.brief })));
      setLoaded(true);
    }
  }, [editing, loaded]);

  const withMockup = (leads ?? []).filter((l) => l.steps.find((s) => s.key === "generate")?.status === "done");
  useEffect(() => {
    if (!leadId && withMockup.length === 1) setLeadId(withMockup[0].id);
  }, [leadId, withMockup]);
  const lead = withMockup.find((l) => l.id === leadId);

  async function submit(start: boolean) {
    setBusy(true);
    setError(null);
    try {
      const body = { leadId, homepageChanges: changes, details, pages };
      let b: Build;
      if (editing) {
        b = await api<Build>(`/api/builds/${editing.id}`, { method: "PUT", json: body });
        if (start) await api(`/api/builds/${b.id}/start`, { method: "POST", json: {} });
      } else {
        b = await api<Build>("/api/builds", { method: "POST", json: { ...body, start } });
      }
      reloadAll();
      nav(`/builds/${b.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (id && !editing) return <p className="muted">Loading…</p>;

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/builds/all">Builds</Link><span className="sep">/</span>
        {editing ? <><Link to={`/builds/${editing.id}`}>{editing.business}</Link><span className="sep">/</span><span className="here">Edit brief</span></> : <span className="here">New build</span>}
      </nav>
      <div className="title-row">
        <h1 className="page-title">{editing ? "Edit brief" : "New build"}</h1>
      </div>
      {editing && <div className="banner"><XCircle />Saving changes to the brief resets this build, so every page is written again.</div>}

      <div className="set-stack">
        <section className="set-section">
          <h3 className="set-title"><Sparkles />Approved mockup</h3>
          <div className="set-body">
            {withMockup.length ? (
              <div className="set-grid">
                <Field label="Build from" htmlFor="b-lead" hint="Only leads with a finished mockup can be built">
                  <Dropdown field id="b-lead" label="Approved mockup" icon={<Sparkles />} value={leadId}
                    onChange={setLeadId}
                    options={[{ value: "", label: "Pick a mockup" }, ...withMockup.map((l) => ({ value: l.id, label: l.business || host(l.url), hint: host(l.url) }))]} />
                </Field>
                {lead && (
                  <div className="mockup-thumb">
                    <img src={fileUrl(lead.id, "mockup-desktop.jpg")} alt={`Approved mockup for ${lead.business || host(lead.url)}`} />
                  </div>
                )}
              </div>
            ) : (
              <div className="set-card">No finished mockups yet. Create one in the Mockups workspace first.</div>
            )}
          </div>
        </section>

        <section className="set-section">
          <h3 className="set-title"><PenLine />Homepage changes</h3>
          <div className="set-body">
            <Field label="What the client wants changed on the homepage" htmlFor="b-changes" hint="One change per line works best. Leave empty to use the approved mockup as it is.">
              <textarea id="b-changes" className="input textarea" rows={5} value={changes} onChange={(e) => setChanges(e.target.value)}
                placeholder={"Make the hero headline mention emergency repairs\nSwap the second photo for the van photo\nAdd opening hours to the footer"} />
            </Field>
          </div>
        </section>

        <section className="set-section">
          <h3 className="set-title"><FileText />Project details</h3>
          <div className="set-body">
            <Field label="Everything the client sent after approval" htmlFor="b-details" hint="Services, prices, team, service areas, opening hours, testimonials, tone of voice… Anything here counts as a verified fact the pages can use.">
              <textarea id="b-details" className="input textarea" rows={10} value={details} onChange={(e) => setDetails(e.target.value)}
                placeholder={"Services: …\nService area: …\nOpening hours: …\nContact: …"} />
            </Field>
          </div>
        </section>

        <section className="set-section">
          <h3 className="set-title"><LayoutTemplate />Pages</h3>
          <div className="set-body">
            <PagesEditor pages={pages} onChange={setPages} />
          </div>
        </section>
      </div>

      {error && <div className="banner err"><XCircle />{error}</div>}
      <div className="set-actions">
        <button type="button" className="btn btn-ink" disabled={busy || !leadId} onClick={() => submit(true)}>{busy ? "Starting…" : "Start build"} <ArrowRight /></button>
        <button type="button" className="btn btn-chip" disabled={busy || !leadId} onClick={() => submit(false)}>Save as draft</button>
      </div>
    </>
  );
}
