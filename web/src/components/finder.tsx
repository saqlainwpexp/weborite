import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Globe, Mail, MapPin, MessageCircle, Star } from "lucide-react";
import type { FinderSearch, Prospect, SearchStatus } from "../../../shared/types";
import { api, host, timeAgo } from "../lib/api";
import { Modal } from "./ui";
import { Dropdown } from "./Dropdown";

export function NewSearchModal({ onClose, onCreated }: { onClose: () => void; onCreated: (s: FinderSearch) => void }) {
  const [query, setQuery] = useState("");
  const [max, setMax] = useState("20");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await api<FinderSearch>("/api/finder/searches", { method: "POST", json: { query, max: Number(max) } }));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Find leads" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="input-group">
          <label htmlFor="s-query">What are you looking for?</label>
          <div className="input-icon">
            <MapPin />
            <input id="s-query" className="input" placeholder="HVAC companies in Rotterdam" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus required minLength={3} />
          </div>
          <span className="hint">Type it the way you'd search Google Maps: a trade plus a city or area.</span>
        </div>
        <div className="form-row">
          <div className="input-group">
            <label htmlFor="s-source">Source</label>
            <Dropdown field id="s-source" label="Source" icon={<MapPin />} value="google_maps" onChange={() => {}}
              options={[{ value: "google_maps", label: "Google Maps", hint: "More directories later" }]} />
          </div>
          <div className="input-group">
            <label htmlFor="s-max">How many</label>
            <Dropdown field id="s-max" label="How many results" value={max} onChange={setMax}
              options={[
                { value: "3", label: "3 businesses", hint: "Quick test" },
                { value: "10", label: "10 businesses" },
                { value: "20", label: "20 businesses", hint: "About 2–3 minutes" },
                { value: "40", label: "40 businesses" },
                { value: "60", label: "60 businesses", hint: "About 8–10 minutes" },
              ]} />
          </div>
        </div>
        {error && <p className="error-text">{error}</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12 }}>
          <button type="button" className="btn btn-chip" onClick={onClose}>Cancel</button>
          <button className="btn btn-ink btn-wide" disabled={busy}>{busy ? "Starting…" : "Start search"}</button>
        </div>
      </form>
    </Modal>
  );
}

const TAG_META: Record<string, { label: string; icon: typeof Mail; cls: string }> = {
  email: { label: "Email", icon: Mail, cls: "tag-email" },
  whatsapp: { label: "WhatsApp", icon: MessageCircle, cls: "tag-wa" },
  website: { label: "Website", icon: Globe, cls: "tag-site" },
  "no-website": { label: "No website", icon: Globe, cls: "tag-none" },
};

export function Tags({ tags, compact = false }: { tags: string[]; compact?: boolean }) {
  const shown = compact ? tags.filter((t) => t === "email" || t === "whatsapp") : tags;
  if (!shown.length) return <span className="muted" style={{ fontSize: 13 }}>—</span>;
  return (
    <span className="tags">
      {shown.map((t) => {
        const m = TAG_META[t];
        if (!m) return null;
        const Icon = m.icon;
        return <span key={t} className={`tag ${m.cls}`}><Icon />{m.label}</span>;
      })}
    </span>
  );
}

const SEARCH_LABEL: Record<SearchStatus, string> = {
  queued: "Queued",
  searching: "Searching Maps",
  enriching: "Scanning websites",
  done: "Done",
  failed: "Stopped",
};

export function SearchStatusPill({ status }: { status: SearchStatus }) {
  const cls = status === "done" ? "ready" : status === "failed" ? "failed" : "running";
  return <span className={`status ${cls}`}><span className="dot" />{SEARCH_LABEL[status]}</span>;
}

export function Rating({ rating, reviews }: { rating: number | null; reviews: number | null }) {
  if (rating == null && reviews == null) return <span className="muted">No reviews</span>;
  return (
    <span className="rating">
      <Star className="star" />
      <b>{rating?.toFixed(1) ?? "–"}</b>
      <span className="muted">({(reviews ?? 0).toLocaleString("en-US")})</span>
    </span>
  );
}

export function ProspectsTable({ prospects, searches, compact = false }: { prospects: Prospect[]; searches: FinderSearch[]; compact?: boolean }) {
  const nav = useNavigate();
  if (!prospects.length) {
    return (
      <div className="empty">
        <h4>No leads here yet</h4>
        <p>Start a search with “Find leads” and businesses appear here as they're found.</p>
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Business</th>
            <th className="hide-sm">Phone</th>
            <th>Reviews</th>
            {!compact && <th className="hide-sm">Website</th>}
            <th>Tags</th>
            {!compact && <th className="hide-sm">Search</th>}
            <th aria-label="Open" />
          </tr>
        </thead>
        <tbody>
          {prospects.map((p) => {
            const s = searches.find((x) => x.id === p.searchId);
            return (
              <tr key={p.id} className="row" onClick={() => nav(`/finder/leads/${p.id}`)}>
                <td>
                  <div className="lead-cell">
                    <span className="biz-mark" aria-hidden="true">{p.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase() || "•"}</span>
                    <div style={{ minWidth: 0 }}>
                      <b>{p.name}</b>
                      <span>{p.category || "Business"}{p.enrichStatus === "running" || p.enrichStatus === "pending" ? " · scanning…" : ""}</span>
                    </div>
                  </div>
                </td>
                <td className="hide-sm nowrap">{p.phone || <span className="muted">—</span>}</td>
                <td className="nowrap"><Rating rating={p.rating} reviews={p.reviews} /></td>
                {!compact && (
                  <td className="hide-sm">
                    {p.website ? (
                      <a className="ext-link" href={p.website} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{host(p.website)}</a>
                    ) : <span className="muted">—</span>}
                  </td>
                )}
                <td><Tags tags={p.tags} compact /></td>
                {!compact && (
                  <td className="hide-sm">
                    {s ? <span className="vchip"><i style={{ background: s.color }} /><span className="clip">{s.query}</span></span> : null}
                  </td>
                )}
                <td style={{ textAlign: "right" }}>
                  <span className="btn btn-sm btn-icon btn-chip" aria-hidden="true"><ArrowRight /></span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function SearchRow({ s, onOpen }: { s: FinderSearch; onOpen: () => void }) {
  const pct = s.status === "searching" ? Math.min(100, Math.round((s.found / s.max) * 50)) : s.status === "enriching" ? 50 + Math.round((s.enriched / Math.max(1, s.found)) * 50) : s.status === "done" ? 100 : 0;
  const active = s.status === "queued" || s.status === "searching" || s.status === "enriching";
  return (
    <button type="button" className="search-row" onClick={onOpen}>
      <span className="sq" style={{ background: s.color }} />
      <span className="search-main">
        <b>{s.query}</b>
        <small>
          {s.found} found · {s.withEmail} with email · {s.withWhatsapp} on WhatsApp · {timeAgo(s.createdAt)}
          {s.error && s.status === "failed" ? ` · ${s.error}` : ""}
        </small>
        {active && <span className="progress" aria-label={`${pct}% done`}><i style={{ width: `${Math.max(pct, 4)}%` }} /></span>}
      </span>
      <SearchStatusPill status={s.status} />
    </button>
  );
}
