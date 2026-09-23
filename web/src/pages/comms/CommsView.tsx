import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Bell, BellOff, Code2, ExternalLink, Home, LogOut, Minus, MoreHorizontal, Pencil, Plus, RotateCw, Trash2, XCircle } from "lucide-react";
import type { CommsService } from "../../../../shared/types";
import type { LayoutCtx } from "../../layout/Layout";
import { api, host } from "../../lib/api";
import { desktop, isDesktop, type ChannelAction } from "../../lib/desktop";
import { ChannelTile, DesktopOnly } from "./CommsHome";

export default function CommsView() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { commsServices, commsState, overlay, reloadAll } = useOutletContext<LayoutCtx>();
  const svc = commsServices?.find((s) => s.id === id);
  const st = commsState[id];
  const hostRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  const [rename, setRename] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hidden = overlay || menu;

  // Keep the live channel view glued to the panel: size, scroll, window resizes, sidebar collapse.
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!desktop || !el || !svc) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top;
      el.style.height = `${Math.max(320, window.innerHeight - top - 16)}px`;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    };
    if (hidden) {
      desktop.comms.hide();
      return;
    }
    desktop.comms.show(svc.id, measure());
    const update = () => desktop!.comms.bounds(measure());
    const ro = new ResizeObserver(update);
    ro.observe(el);
    ro.observe(document.body);
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
    };
  }, [svc?.id, hidden]);
  useEffect(() => () => desktop?.comms.hide(), []);

  if (commsServices && !svc) return <div className="banner err"><XCircle />This channel was removed. <Link to="/comms">All channels</Link></div>;
  if (!svc) return <p className="muted">Loading…</p>;

  const act = (a: ChannelAction) => void desktop?.comms.action(svc.id, a);
  const patch = async (body: Partial<CommsService>) => {
    setError(null);
    try {
      await api(`/api/comms/${svc.id}`, { method: "PUT", json: body });
      await desktop?.comms.sync();
      reloadAll();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const close = () => setMenu(false);

  return (
    <div className="comms-view">
      <div className="ch-bar">
        <ChannelTile svc={svc} state={st} size={36} />
        {rename !== null ? (
          <form className="ch-rename" onSubmit={(e) => { e.preventDefault(); if (rename.trim()) void patch({ name: rename.trim() }); setRename(null); }}>
            <input className="input" value={rename} onChange={(e) => setRename(e.target.value)} aria-label="Channel name" autoFocus onKeyDown={(e) => e.key === "Escape" && setRename(null)} />
            <button className="btn btn-ink btn-sm">Save</button>
            <button type="button" className="btn btn-chip btn-sm" onClick={() => setRename(null)}>Cancel</button>
          </form>
        ) : (
          <div className="ch-name">
            <b>{svc.name}</b>
            <span className="muted">{st?.loading ? "Loading…" : st?.url ? host(st.url) : host(svc.url)}</span>
          </div>
        )}
        {isDesktop && (
          <div className="ch-tools">
            <button className="icon-btn sm" title="Back" aria-label="Back" disabled={!st?.canGoBack} onClick={() => act("back")}><ArrowLeft /></button>
            <button className="icon-btn sm" title="Forward" aria-label="Forward" disabled={!st?.canGoForward} onClick={() => act("forward")}><ArrowRight /></button>
            <button className="icon-btn sm" title="Reload" aria-label="Reload" onClick={() => act("reload")}><RotateCw className={st?.loading ? "spin" : ""} /></button>
            <button className="icon-btn sm" title={`Back to ${host(svc.url)}`} aria-label="Home" onClick={() => act("home")}><Home /></button>
            <button className="icon-btn sm" title={svc.muted ? "Unmute" : "Mute: no badge or notifications"} aria-label={svc.muted ? "Unmute" : "Mute"} onClick={() => void patch({ muted: !svc.muted })}>{svc.muted ? <BellOff /> : <Bell />}</button>
            <div className="pop-anchor">
              <button className="icon-btn sm" title="More" aria-label="More" aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal /></button>
              {menu && (
                <div className="popover right" style={{ width: 250 }} role="menu">
                  <button className="nav-item menu-row" onClick={() => { close(); setRename(svc.name); }}><Pencil />Rename</button>
                  <button className="nav-item menu-row" onClick={() => { close(); act("zoom-in"); }}><Plus />Zoom in</button>
                  <button className="nav-item menu-row" onClick={() => { close(); act("zoom-out"); }}><Minus />Zoom out</button>
                  <button className="nav-item menu-row" onClick={() => { close(); act("zoom-reset"); }}><RotateCw />Reset zoom</button>
                  <button className="nav-item menu-row" onClick={() => { close(); desktop?.openExternal(st?.url || svc.url); }}><ExternalLink />Open in browser</button>
                  <button className="nav-item menu-row" onClick={() => { close(); act("devtools"); }}><Code2 />Developer tools</button>
                  <div className="side-divider" />
                  <button className="nav-item menu-row" onClick={() => { close(); if (confirm(`Sign out of ${svc.name}? This clears its saved login and data in the app.`)) act("signout"); }}><LogOut />Sign out</button>
                  <button className="nav-item menu-row danger" onClick={async () => { close(); if (confirm(`Remove ${svc.name}? Its login in the app is forgotten.`)) { act("signout"); await api(`/api/comms/${svc.id}`, { method: "DELETE" }); await desktop?.comms.sync(); reloadAll(); nav("/comms"); } }}><Trash2 />Remove channel</button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {error && <div className="banner err"><XCircle />{error}</div>}
      {isDesktop ? (
        <div ref={hostRef} className="ch-host">
          {st?.crashed && <div className="ch-host-msg"><p>{svc.name} stopped.</p><button className="btn btn-ink btn-sm" onClick={() => act("reload")}><RotateCw />Reload</button></div>}
          {hidden && <div className="ch-host-msg"><p className="muted">{svc.name}</p></div>}
        </div>
      ) : (
        <>
          <DesktopOnly />
          <div className="card card-lg" style={{ textAlign: "center" }}>
            <a className="btn btn-ink" href={svc.url} target="_blank" rel="noreferrer"><ExternalLink />Open {svc.name} in a new tab</a>
          </div>
        </>
      )}
    </div>
  );
}
