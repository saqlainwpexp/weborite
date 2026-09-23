import { useNavigate, useOutletContext } from "react-router-dom";
import { ArrowRight, ArrowUpRight, Flame, Mail, MessageCircle, Users } from "lucide-react";
import type { LayoutCtx } from "../../layout/Layout";
import { ProspectsTable, SearchRow } from "../../components/finder";

export default function FinderDashboard() {
  const { prospects, searches, finderStats: st, openAdd } = useOutletContext<LayoutCtx>();
  const nav = useNavigate();
  const pct = (n: number) => (st && st.total ? `${Math.round((n / st.total) * 100)}% of leads` : "—");

  const stats = [
    { label: "Leads found", value: st?.total, sub: `${st?.searches ?? 0} searches`, icon: <Users /> },
    { label: "With email", value: st?.withEmail, sub: pct(st?.withEmail ?? 0), icon: <Mail /> },
    { label: "On WhatsApp", value: st?.withWhatsapp, sub: pct(st?.withWhatsapp ?? 0), icon: <MessageCircle /> },
    { label: "Hot leads", value: (prospects ?? []).filter((p) => p.fit?.status === "done" && p.fit.grade === "hot").length, sub: `${(prospects ?? []).filter((p) => !p.website).length} with no website`, icon: <Flame /> },
  ];

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span>Lead Finder</span><span className="sep">/</span><span className="here">Dashboard</span></nav>
      <div className="title-row">
        <h1 className="page-title">Overview</h1>
        <div className="actions">
          <button className="btn btn-white" onClick={() => nav("/finder/leads")}>All leads</button>
          <button className="btn btn-ink" onClick={openAdd}>Find leads <ArrowRight /></button>
        </div>
      </div>

      <div className="grid-main">
        <div className="stack">
          <div className="four">
            {stats.map((s) => (
              <div key={s.label} className="card stat">
                <div className="top"><span className="tile">{s.icon}</span></div>
                <div>
                  <b>{st ? s.value : "–"}</b>
                  <span style={{ display: "block", marginTop: 8 }}>{s.label}</span>
                  <small className="muted" style={{ fontSize: 13 }}>{st ? s.sub : ""}</small>
                </div>
              </div>
            ))}
          </div>

          <div className="card card-lg">
            <div className="card-head" style={{ marginBottom: 20 }}>
              <div>
                <h3 className="card-title">Latest leads</h3>
                <p className="card-sub">Newest businesses found across all searches</p>
              </div>
              <button className="btn btn-chip btn-sm" onClick={() => nav("/finder/leads")}>View all</button>
            </div>
            <ProspectsTable compact prospects={(prospects ?? []).slice(0, 8)} searches={searches ?? []} />
          </div>
        </div>

        <div className="stack side-col">
          <div className="card">
            <h3 className="card-title">Searches <ArrowUpRight size={22} strokeWidth={1.6} /></h3>
            <p className="card-sub">Each search runs Google Maps, then scans every website</p>
            <div className="search-list">
              {(searches ?? []).slice(0, 5).map((s) => <SearchRow key={s.id} s={s} onOpen={() => nav(`/finder/leads?search=${s.id}`)} />)}
              {!searches?.length && (
                <div className="empty" style={{ padding: "28px 8px" }}>
                  <p>No searches yet.</p>
                </div>
              )}
            </div>
            <div className="notif-foot">
              <button className="btn btn-ink btn-sm" onClick={openAdd}>New search <ArrowRight /></button>
              <button className="link-btn" onClick={() => nav("/finder/searches")}>All searches</button>
            </div>
          </div>

          <div className="card">
            <h3 className="card-title">How tags work</h3>
            <dl className="fields">
              <div className="field"><dt>Email</dt><dd>An address was found on their website, including contact and “over ons” pages.</dd></div>
              <div className="field"><dt>WhatsApp</dt><dd>Their number has a WhatsApp Business profile, or their site links to WhatsApp.</dd></div>
              <div className="field"><dt>No website</dt><dd>Only a Maps listing. These are prime prospects for a new site.</dd></div>
            </dl>
          </div>
        </div>
      </div>
    </>
  );
}
