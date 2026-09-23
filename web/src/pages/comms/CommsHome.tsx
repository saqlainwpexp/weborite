import { useNavigate, useOutletContext } from "react-router-dom";
import { ArrowRight, ExternalLink, Monitor, Plus } from "lucide-react";
import type { CommsService } from "../../../../shared/types";
import type { LayoutCtx } from "../../layout/Layout";
import { host } from "../../lib/api";
import { desktop, isDesktop, type ChannelState } from "../../lib/desktop";

export function ChannelTile({ svc, state, size = 40 }: { svc: CommsService; state?: ChannelState; size?: number }) {
  return (
    <span className="ch-tile" style={{ width: size, height: size, background: state?.favicon ? "#fff" : svc.color }} aria-hidden="true">
      {state?.favicon ? <img src={state.favicon} alt="" /> : svc.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function UnreadBadge({ n, muted }: { n: number | undefined; muted?: boolean }) {
  if (muted || !n) return null;
  return <span className="unread">{n < 0 ? "" : n > 99 ? "99+" : n}</span>;
}

export function DesktopOnly() {
  return (
    <div className="banner" style={{ background: "var(--accent-softer)", color: "var(--text)" }}>
      <Monitor />
      <span>Channels open inside <b style={{ fontWeight: 500 }}>the Weborite Studio desktop app</b>. WhatsApp, Gmail, Discord and most others refuse to be shown inside a web page, so in the browser each one opens in its own tab instead.</span>
    </div>
  );
}

export default function CommsHome() {
  const { commsServices, commsState } = useOutletContext<LayoutCtx>();
  const nav = useNavigate();
  const list = commsServices ?? [];
  const total = list.reduce((a, s) => a + (s.muted ? 0 : Math.max(0, commsState[s.id]?.unread ?? 0)), 0);
  const open = (s: CommsService) => (isDesktop ? nav(`/comms/${s.id}`) : window.open(s.url, "_blank", "noopener"));

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span>Communication</span><span className="sep">/</span><span className="here">All channels</span></nav>
      <div className="title-row">
        <div>
          <h1 className="page-title">Communication</h1>
          <p className="muted" style={{ marginTop: 8 }}>{list.length ? `${list.length} channel${list.length === 1 ? "" : "s"}${isDesktop ? ` · ${total ? `${total} unread` : "all caught up"}` : ""}` : "Every inbox in one place"}</p>
        </div>
        <div className="actions"><button className="btn btn-ink" onClick={() => nav("/comms/new")}>Add channel <ArrowRight /></button></div>
      </div>
      {!isDesktop && <DesktopOnly />}

      {commsServices && !list.length ? (
        <div className="card card-lg">
          <div className="empty">
            <h4>Add your first channel</h4>
            <p>WhatsApp, Messenger, Gmail, Discord, Slack, Upwork… Each runs as its own signed-in tab inside the app, with notifications and unread counts.</p>
            <button className="btn btn-ink" style={{ marginTop: 16 }} onClick={() => nav("/comms/new")}><Plus />Add a channel</button>
          </div>
        </div>
      ) : (
        <div className="ch-grid">
          {list.map((s) => {
            const st = commsState[s.id];
            return (
              <button key={s.id} type="button" className="card ch-card" onClick={() => open(s)}>
                <div className="ch-card-top">
                  <ChannelTile svc={s} state={st} size={44} />
                  <UnreadBadge n={st?.unread} muted={s.muted} />
                </div>
                <b>{s.name}</b>
                <span className="muted">{host(s.url)}</span>
                <span className="ch-status">
                  {!isDesktop ? <><ExternalLink size={14} />Opens in a new tab</>
                    : st?.crashed ? <span className="bad">Stopped: open to reload</span>
                    : st?.loading ? "Loading…"
                    : s.muted ? "Muted"
                    : st?.unread ? (st.unread < 0 ? "New activity" : `${st.unread} unread`) : "Up to date"}
                </span>
              </button>
            );
          })}
          <button type="button" className="card ch-card ch-add" onClick={() => nav("/comms/new")}><Plus /><b>Add channel</b><span className="muted">Another service or account</span></button>
        </div>
      )}
      {isDesktop && list.length > 0 && <p className="muted" style={{ fontSize: 13 }}>Channels stay signed in and keep receiving messages while the app runs, including from the tray. <button type="button" className="link-btn" onClick={() => void desktop!.comms.sync()}>Refresh all</button></p>}
    </>
  );
}
