import { useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import {
  ArrowRight, ArrowUpRight, CheckCircle2, Copy, ExternalLink, Gauge, Globe, Mail, MapPin, MessageCircle, Minus, Phone, Plus, RefreshCw, Sparkles, Trash2, XCircle,
} from "lucide-react";
import type { FinderSearch, Lead, Prospect } from "../../../../shared/types";
import type { LayoutCtx } from "../../layout/Layout";
import { api, host, timeAgo, usePoll } from "../../lib/api";
import { FitPill, Rating, Tags } from "../../components/finder";
import { StatusPill } from "../../components/ui";

type Detail = Prospect & { search: FinderSearch | null; mockup: Lead | null };

const WA_TEXT: Record<Prospect["whatsapp"], string> = {
  business_profile: "WhatsApp Business profile found for this number",
  site_link: "Their website links to WhatsApp",
  unconfirmed: "No WhatsApp Business profile found. They may still use personal WhatsApp.",
  no_phone: "No phone number listed",
  pending: "Checking…",
};

function CopyBtn({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="icon-btn sm" aria-label={`Copy ${value}`} title="Copy" onClick={() => { void navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1200); }}>
      {done ? <CheckCircle2 /> : <Copy />}
    </button>
  );
}

export default function FinderLeadDetail() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { reloadAll } = useOutletContext<LayoutCtx>();
  const { data: p, error, reload } = usePoll<Detail>(`/api/finder/prospects/${id}`, 4000);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (error && !p) return <div className="banner err"><XCircle />{error}</div>;
  if (!p) return <p className="muted">Loading…</p>;

  const waDigits = p.phone.replace(/[^\d]/g, "");
  const scanning = p.enrichStatus === "pending" || p.enrichStatus === "running";

  const fit = p.fit;
  const a = fit?.audit;
  const secs = (ms: number | null) => (ms == null ? "–" : `${(ms / 1000).toFixed(1)}s`);
  const rescore = async () => {
    await api(`/api/finder/prospects/${p.id}/qualify`, { method: "POST" });
    void reload();
  };

  async function act(kind: "mockup" | "enrich" | "delete") {
    setBusy(kind);
    setErr(null);
    try {
      if (kind === "mockup") {
        const r = await api<{ leadId: string }>(`/api/finder/prospects/${p!.id}/mockup`, { method: "POST" });
        reloadAll();
        nav(`/leads/${r.leadId}`);
        return;
      }
      if (kind === "enrich") await api(`/api/finder/prospects/${p!.id}/enrich`, { method: "POST" });
      if (kind === "delete") {
        if (!confirm(`Remove ${p!.name} from your leads?`)) return;
        await api(`/api/finder/prospects/${p!.id}`, { method: "DELETE" });
        reloadAll();
        nav("/finder/leads");
        return;
      }
      void reload();
      reloadAll();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/finder/leads">Leads</Link>
        {p.search && <><span className="sep">/</span><Link to={`/finder/leads?search=${p.search.id}`}>{p.search.query}</Link></>}
        <span className="sep">/</span><span className="here">{p.name}</span>
      </nav>
      <div className="title-row">
        <div>
          <h1 className="page-title">{p.name}</h1>
          <p className="muted" style={{ marginTop: 8 }}>{p.category || "Business"} · found {timeAgo(p.createdAt)}</p>
        </div>
        <div className="actions">
          <button className="btn btn-white" onClick={() => act("enrich")} disabled={busy !== null || scanning}><RefreshCw />{scanning ? "Scanning…" : "Rescan"}</button>
          <a className="btn btn-white" href={p.mapsUrl} target="_blank" rel="noreferrer"><MapPin />Google Maps</a>
          {p.mockupLeadId ? (
            <button className="btn btn-ink" onClick={() => nav(`/leads/${p.mockupLeadId}`)}>View mockup <ArrowRight /></button>
          ) : (
            <button className="btn btn-ink" onClick={() => act("mockup")} disabled={!p.website || busy !== null} title={p.website ? "Send to the Mockups workspace" : "No website to rebuild"}>
              <Sparkles />{busy === "mockup" ? "Creating…" : "Create mockup"}
            </button>
          )}
        </div>
      </div>
      {err && <div className="banner err"><XCircle />{err}</div>}

      <div className="grid-main">
        <div className="stack">
          <div className="card card-lg">
            <div className="card-head">
              <div><h3 className="card-title">Is this a good prospect?</h3><p className="card-sub">{fit?.status === "done" ? fit.summary : fit?.status === "failed" ? `Couldn't score: ${fit.note ?? ""}` : fit ? "Auditing their website and reviewing the design…" : "Not scored yet"}</p></div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <FitPill p={p} />
                <button className="btn btn-chip btn-sm" onClick={() => void rescore()} disabled={fit?.status === "running" || fit?.status === "pending"}><Gauge />{fit ? "Re-score" : "Score"}</button>
              </div>
            </div>
            {fit?.status === "done" && (
              <div className="fit-grid">
                <ul className="fit-reasons">
                  {fit.reasons.map((r, i) => (
                    <li key={i} className={r.points > 0 ? "plus" : r.points < 0 ? "minus" : ""}>
                      <span className="fit-pts">{r.points > 0 ? <><Plus size={12} />{r.points}</> : r.points < 0 ? <><Minus size={12} />{-r.points}</> : "•"}</span>
                      <span>{r.text}</span>
                    </li>
                  ))}
                </ul>
                {a?.shot && <a href={`/api/finder/prospects/${p.id}/shot`} target="_blank" rel="noreferrer" className="fit-shot"><img src={`/api/finder/prospects/${p.id}/shot?t=${encodeURIComponent(fit.at)}`} alt={`${p.name} homepage`} /></a>}
              </div>
            )}
            {fit?.status === "done" && a && a.reachable && !a.socialOnly && (
              <dl className="fields">
                <div className="field"><dt>Security</dt><dd>{a.sslError ? <span className="bad">Certificate error</span> : a.https ? "HTTPS" : <span className="bad">No HTTPS</span>}</dd></div>
                <div className="field"><dt>Mobile</dt><dd>{!a.mobile.viewport ? <span className="bad">No mobile layout</span> : a.mobile.overflow ? <span className="warn">Scrolls sideways</span> : "Mobile-friendly"}</dd></div>
                <div className="field"><dt>Load time (mobile)</dt><dd>{secs(a.loadMs)}{a.bytes ? ` · ${(a.bytes / 1048576).toFixed(1)} MB · ${a.requests} requests` : ""}</dd></div>
                <div className="field"><dt>SEO basics</dt><dd>{[a.seo.title ? "title" : "no title", a.seo.description ? "description" : "no description", `${a.seo.h1} H1`, a.seo.schema.length ? `schema: ${a.seo.schema.slice(0, 2).join(", ")}` : "no schema"].join(" · ")}</dd></div>
                <div className="field"><dt>Contact on site</dt><dd>{[a.contact.tel && "click-to-call", a.contact.form && "form", a.contact.whatsapp && "WhatsApp", a.contact.email && "email link"].filter(Boolean).join(", ") || <span className="bad">None found</span>}</dd></div>
                <div className="field"><dt>Built with</dt><dd>{a.builder || "Unknown"}{a.copyrightYear ? ` · © ${a.copyrightYear}` : ""}</dd></div>
              </dl>
            )}
            {fit?.status === "done" && <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>Google ranking isn't checked (Google blocks automated searches); the site's technical and design quality stand in for it.{fit.note ? ` ${fit.note}.` : ""}</p>}
          </div>

          <div className="two">
            <div className="card task-card">
              <div className="chips"><Tags tags={p.tags} /></div>
              <div>
                <h4>Contact</h4>
                <p className="sub">{p.address || "No address listed"}</p>
              </div>
              <div className="contact-list">
                <div className="contact-line"><Phone />{p.phone ? <a href={`tel:${p.phone}`}>{p.phone}</a> : <span className="muted">No phone</span>}{p.phone && <CopyBtn value={p.phone} />}</div>
                <div className="contact-line"><Globe />{p.website ? <a href={p.website} target="_blank" rel="noreferrer">{host(p.website)}</a> : <span className="muted">No website</span>}</div>
              </div>
            </div>
            <div className="card task-card">
              <div className="chips"><span className="chip">Google Maps</span></div>
              <div>
                <h4>Reputation</h4>
                <p className="sub">Rating and review count from the Maps listing</p>
              </div>
              <div className="big-rating"><Rating rating={p.rating} reviews={p.reviews} /></div>
            </div>
          </div>

          <div className="card card-lg">
            <h3 className="card-title">Emails</h3>
            <p className="card-sub">{scanning ? "Scanning their website…" : p.website ? `${p.enrichNote ?? "Website scanned"}. Addresses on their own domain are listed first.` : "No website to scan."}</p>
            <ul className="email-list">
              {p.emails.map((e, i) => (
                <li key={e}>
                  <Mail />
                  <a href={`mailto:${e}`}>{e}</a>
                  {p.emailPages[i] && <a className="found-on" href={p.emailPages[i]} target="_blank" rel="noreferrer">found on {new URL(p.emailPages[i]).pathname === "/" ? "homepage" : new URL(p.emailPages[i]).pathname}</a>}
                  <CopyBtn value={e} />
                </li>
              ))}
              {!p.emails.length && !scanning && <li className="muted"><Mail />No email found on their website</li>}
            </ul>
          </div>

          <div className="card card-lg">
            <h3 className="card-title">WhatsApp</h3>
            <p className="card-sub">{WA_TEXT[p.whatsapp]}{p.whatsappName ? `: “${p.whatsappName}”` : ""}</p>
            <div className="wa-row">
              <span className={`wa-state ${p.tags.includes("whatsapp") ? "yes" : "no"}`}>
                <MessageCircle />{p.tags.includes("whatsapp") ? "On WhatsApp" : p.whatsapp === "pending" ? "Checking" : "Not confirmed"}
              </span>
              {waDigits && <a className="btn btn-outline btn-sm" href={`https://wa.me/${waDigits}`} target="_blank" rel="noreferrer">Open wa.me link <ExternalLink /></a>}
            </div>
          </div>
        </div>

        <div className="stack side-col">
          <div className="card">
            <h3 className="card-title">Details <ArrowUpRight size={22} strokeWidth={1.6} /></h3>
            <p className="card-sub">Scraped from the Google Maps listing</p>
            <dl className="fields">
              <div className="field"><dt>Business</dt><dd>{p.name}</dd></div>
              <div className="field"><dt>Category</dt><dd>{p.category || "—"}</dd></div>
              <div className="field"><dt>Phone</dt><dd>{p.phone || "—"}</dd></div>
              <div className="field"><dt>Website</dt><dd>{p.website || "—"}</dd></div>
              <div className="field"><dt>Reviews</dt><dd>{p.reviews ?? "—"}</dd></div>
              <div className="field"><dt>Search</dt><dd>{p.search?.query ?? "—"}</dd></div>
            </dl>
          </div>

          <div className="card">
            <h3 className="card-title">Mockup</h3>
            <p className="card-sub">{p.mockup ? "This business is in the Mockups workspace" : p.website ? "Rebuild their homepage in the Mockups workspace" : "Needs a website before a mockup can be made"}</p>
            <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              {p.mockup ? (
                <>
                  <StatusPill status={p.mockup.status} />
                  <Link className="link-btn" to={`/leads/${p.mockup.id}`}>Open lead <ArrowRight /></Link>
                </>
              ) : (
                <button className="btn btn-accent btn-sm" onClick={() => act("mockup")} disabled={!p.website || busy !== null}><Sparkles />Create mockup</button>
              )}
            </div>
          </div>

          <button className="btn btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => act("delete")}><Trash2 />Remove lead</button>
        </div>
      </div>
    </>
  );
}
