import { useNavigate, useOutletContext } from "react-router-dom";
import { ArrowRight, Square, Trash2 } from "lucide-react";
import type { LayoutCtx } from "../../layout/Layout";
import { SearchRow } from "../../components/finder";
import { api } from "../../lib/api";

export default function FinderSearches() {
  const { searches, openAdd, reloadAll } = useOutletContext<LayoutCtx>();
  const nav = useNavigate();

  async function act(id: string, kind: "stop" | "rerun" | "delete") {
    if (kind === "delete" && !confirm("Delete this search and every lead it found?")) return;
    await api(`/api/finder/searches/${id}${kind === "delete" ? "" : `/${kind}`}`, { method: kind === "delete" ? "DELETE" : "POST" });
    reloadAll();
  }

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span>Lead Finder</span><span className="sep">/</span><span className="here">Searches</span></nav>
      <div className="title-row">
        <h1 className="page-title">Searches</h1>
        <div className="actions">
          <button className="btn btn-ink" onClick={openAdd}>New search <ArrowRight /></button>
        </div>
      </div>
      <p className="muted" style={{ maxWidth: 640, marginTop: -8 }}>
        Each search reads Google Maps, then scans every website for emails and checks each number for WhatsApp. A business is kept once, even if later searches find it again.
      </p>

      <div className="card card-lg">
        {!searches?.length ? (
          <div className="empty">
            <h4>No searches yet</h4>
            <p>Try something like “HVAC companies in Rotterdam”.</p>
          </div>
        ) : (
          <div className="search-list">
            {searches.map((s) => {
              const active = s.status === "queued" || s.status === "searching" || s.status === "enriching";
              return (
                <div key={s.id} className="search-item">
                  <SearchRow s={s} onOpen={() => nav(`/finder/leads?search=${s.id}`)} />
                  <div className="search-actions">
                    {active ? (
                      <button className="btn btn-chip btn-xs" onClick={() => act(s.id, "stop")}><Square size={12} />Stop</button>
                    ) : (
                      <button className="btn btn-chip btn-xs" onClick={() => act(s.id, "rerun")}>Run again</button>
                    )}
                    <button className="btn btn-ghost btn-xs" aria-label={`Delete ${s.query}`} onClick={() => act(s.id, "delete")}><Trash2 size={13} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
