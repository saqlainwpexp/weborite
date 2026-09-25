import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowRight, Bell, CalendarDays, Check, ChevronDown, Home, Layers, MapPinned, MoreHorizontal, PanelLeftClose, PanelLeftOpen, UserCog,
  Banknote, Blocks, ChartColumn, ClipboardCheck, Contact, Crown, FilePlus2, MessagesSquare, Gauge, ListChecks, PanelsTopLeft, Plus, Radar, Search, Server, Settings as SettingsIcon, Sparkles, UserPlus, Users, Workflow, Wrench,
} from "lucide-react";
import type { BenchmarkSet, Build, BuildStats, CommsService, EventItem, FinderSearch, FinderStats, Lead, Prospect, SeoSite, Settings, Usage, WpConversion } from "../../../shared/types";
import { api, host, timeAgo, usePoll } from "../lib/api";
import { AddLeadModal, EventIcon, Logo, StatusPill } from "../components/ui";
import { NewSearchModal } from "../components/finder";
import { Calendar, dayKey, parseDayKey } from "../components/Calendar";
import { applyBrand } from "../lib/brand";
import { ZoomControl } from "../components/ZoomControl";
import { AgentDock } from "../components/Agent";
import { careState, type CareView } from "../pages/care/CareList";
import { desktop, type ChannelState } from "../lib/desktop";
import { ChannelTile, UnreadBadge } from "../pages/comms/CommsHome";

export type Workspace = "admin" | "mockups" | "automations" | "finder" | "builds" | "wordpress" | "seo" | "care" | "comms";

export interface LayoutCtx {
  leads: Lead[] | null;
  events: EventItem[] | null;
  benchmarks: (BenchmarkSet & { leadCount: number })[] | null;
  settings: Settings | null;
  usage: Usage | null;
  prospects: Prospect[] | null;
  searches: FinderSearch[] | null;
  finderStats: FinderStats | null;
  builds: Build[] | null;
  buildStats: BuildStats | null;
  conversions: WpConversion[] | null;
  seoSites: SeoSite[] | null;
  careSites: CareView[] | null;
  commsServices: CommsService[] | null;
  commsState: Record<string, ChannelState>;
  /** A popover or modal is open: native channel views must step aside so it isn't hidden under them. */
  overlay: boolean;
  workspace: Workspace;
  reloadAll: () => void;
  openAdd: () => void;
}

const WORKSPACES: { key: Workspace; label: string; hint: string; home: string; icon: typeof Sparkles }[] = [
  { key: "admin", label: "Super admin", hint: "Earnings, leads, progress and reports across everything", home: "/admin", icon: Crown },
  { key: "mockups", label: "Mockups", hint: "Rebuild lead homepages with Claude", home: "/", icon: Sparkles },
  { key: "automations", label: "Automations", hint: "Prompt → scrape → auto-mockups → outreach", home: "/campaigns", icon: Workflow },
  { key: "finder", label: "Lead Finder", hint: "Find businesses on Google Maps", home: "/finder", icon: Radar },
  { key: "builds", label: "Builds", hint: "Turn approved mockups into full websites", home: "/builds", icon: Blocks },
  { key: "wordpress", label: "WordPress", hint: "Convert builds into Elementor pages", home: "/wp", icon: PanelsTopLeft },
  { key: "seo", label: "Launch & SEO", hint: "Post-launch QA, speed and on-page SEO", home: "/seo", icon: Gauge },
  { key: "care", label: "Maintenance", hint: "Monthly updates tested on staging, security, health", home: "/care", icon: Wrench },
  { key: "comms", label: "Communication", hint: "WhatsApp, email, Messenger, Discord… in one place", home: "/comms", icon: MessagesSquare },
];

const CARE_DOT: Record<string, string> = {
  running: "var(--amber)", approve: "var(--orange)", stopped: "var(--red)", vulnerable: "var(--red)", updates: "var(--amber)", offline: "var(--faint)", healthy: "var(--green)",
};

const WP_DOT: Record<WpConversion["status"], string> = {
  setup: "var(--faint)", running: "var(--amber)", paused: "var(--amber)", awaiting_approval: "var(--orange)", done: "var(--green)", failed: "var(--red)",
};

const BUILD_DOT: Record<Build["status"], string> = {
  draft: "var(--faint)", queued: "var(--amber)", running: "var(--amber)", paused: "var(--amber)",
  ready: "var(--green)", needs_review: "var(--orange)", failed: "var(--red)",
};

function useClickAway(onAway: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onAway();
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onAway]);
  return ref;
}

const readLocal = (k: string, fallback: string) => {
  try {
    return localStorage.getItem(k) ?? fallback;
  } catch {
    return fallback;
  }
};
const writeLocal = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
};

export default function Layout() {
  const nav = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();

  // Settings are shared, so they keep whichever workspace you came from.
  const [lastWorkspace, setLastWorkspace] = useState<Workspace>(() => {
    const w = readLocal("studio.workspace", "mockups");
    return w === "finder" || w === "builds" || w === "wordpress" || w === "seo" || w === "care" || w === "comms" || w === "admin" ? w : "mockups";
  });
  const path = location.pathname;
  const workspace: Workspace = path.startsWith("/campaigns") ? "automations" : path.startsWith("/finder") ? "finder" : path.startsWith("/builds") ? "builds" : path.startsWith("/wp") ? "wordpress" : path.startsWith("/seo") ? "seo" : path.startsWith("/care") ? "care" : path.startsWith("/comms") ? "comms" : path.startsWith("/admin") ? "admin" : path.startsWith("/settings") ? lastWorkspace : "mockups";
  useEffect(() => {
    if (!path.startsWith("/settings")) {
      setLastWorkspace(workspace);
      writeLocal("studio.workspace", workspace);
    }
  }, [workspace, path]);
  const isFinder = workspace === "finder";
  const isBuilds = workspace === "builds";
  const isWp = workspace === "wordpress";
  const isSeo = workspace === "seo";
  const isCare = workspace === "care";
  const isComms = workspace === "comms";
  const isAdmin = workspace === "admin";

  const leads = usePoll<Lead[]>("/api/leads", 5000);
  const events = usePoll<EventItem[]>("/api/events", 5000);
  const benchmarks = usePoll<(BenchmarkSet & { leadCount: number })[]>("/api/benchmarks", 15000);
  const settings = usePoll<Settings>("/api/settings", 30000);
  const usage = usePoll<Usage>("/api/usage", 5000);
  const prospects = usePoll<Prospect[]>(isFinder ? "/api/finder/prospects" : null, 4000);
  const searches = usePoll<FinderSearch[]>(isFinder ? "/api/finder/searches" : null, 3000);
  const finderStats = usePoll<FinderStats>(isFinder ? "/api/finder/stats" : null, 4000);
  const builds = usePoll<Build[]>(isBuilds || isWp ? "/api/builds" : null, 3000);
  const conversions = usePoll<WpConversion[]>(isWp || isSeo ? "/api/wp" : null, 3000);
  const seoSites = usePoll<SeoSite[]>(isSeo ? "/api/seo" : null, 3000);
  const careSites = usePoll<CareView[]>(isCare ? "/api/care" : null, 4000);
  const commsServices = usePoll<CommsService[]>(isComms || desktop ? "/api/comms" : null, isComms ? 5000 : 30000);
  const [commsState, setCommsState] = useState<Record<string, ChannelState>>({});
  useEffect(() => {
    if (!desktop) return;
    void desktop.comms.state().then(setCommsState);
    const offState = desktop.comms.onState(setCommsState);
    // Clicking a message notification opens that channel.
    const offOpen = desktop.comms.onOpen((id) => nav(`/comms/${id}`));
    return () => {
      offState();
      offOpen();
    };
  }, [nav]);
  const commsUnread = (commsServices.data ?? []).reduce((a, x) => a + (x.muted ? 0 : Math.max(0, commsState[x.id]?.unread ?? 0)), 0);
  const commsActivity = (commsServices.data ?? []).some((x) => !x.muted && (commsState[x.id]?.unread ?? 0) !== 0);
  const buildStats = usePoll<BuildStats>(isBuilds ? "/api/builds/stats" : null, 4000);

  const [adding, setAdding] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => readLocal("studio.sidebar", "open") === "collapsed");
  const toggleSidebar = () => {
    setCollapsed(!collapsed);
    writeLocal("studio.sidebar", !collapsed ? "collapsed" : "open");
  };
  const [popover, setPopover] = useState<"search" | "notif" | "more" | "mode" | "date" | "workspace" | null>(null);
  const [q, setQ] = useState("");
  const close = () => setPopover(null);
  const searchRef = useClickAway(() => popover === "search" && close());
  const notifRef = useClickAway(() => popover === "notif" && close());
  const modeRef = useClickAway(() => popover === "mode" && close());
  const dateRef = useClickAway(() => popover === "date" && close());
  const wsRef = useClickAway(() => popover === "workspace" && close());

  const reloadAll = () => {
    for (const p of [leads, events, usage, benchmarks, settings, prospects, searches, finderStats, builds, buildStats, conversions, seoSites, careSites, commsServices]) void p.reload();
  };

  const ctx: LayoutCtx = {
    leads: leads.data,
    events: events.data,
    benchmarks: benchmarks.data,
    settings: settings.data,
    usage: usage.data,
    prospects: prospects.data,
    searches: searches.data,
    finderStats: finderStats.data,
    builds: builds.data,
    buildStats: buildStats.data,
    conversions: conversions.data,
    seoSites: seoSites.data,
    careSites: careSites.data,
    commsServices: commsServices.data,
    commsState,
    overlay: popover !== null || adding || agentOpen,
    workspace,
    reloadAll,
    openAdd: () => (isAdmin ? nav("/admin/revenue?new=1") : isComms ? nav("/comms/new") : isCare ? nav("/care/new") : isSeo ? nav("/seo/new") : isWp ? nav("/wp/new") : isBuilds ? nav("/builds/new") : setAdding(true)),
  };

  const needle = q.trim().toLowerCase();
  const mockupResults = (leads.data ?? []).filter((l) => !needle || [l.business, l.name, l.email, l.url].join(" ").toLowerCase().includes(needle)).slice(0, 8);
  const commsResults = (commsServices.data ?? []).filter((x) => !needle || [x.name, x.url].join(" ").toLowerCase().includes(needle)).slice(0, 8);
  const careResults = (careSites.data ?? []).filter((x) => !needle || [x.name, x.client, x.siteUrl].join(" ").toLowerCase().includes(needle)).slice(0, 8);
  const seoResults = (seoSites.data ?? []).filter((x) => !needle || [x.name, x.siteUrl].join(" ").toLowerCase().includes(needle)).slice(0, 8);
  const wpResults = (conversions.data ?? []).filter((c) => !needle || [c.business, c.siteUrl].join(" ").toLowerCase().includes(needle)).slice(0, 8);
  const buildResults = (builds.data ?? []).filter((b) => !needle || [b.business, b.url].join(" ").toLowerCase().includes(needle)).slice(0, 8);
  const finderResults = (prospects.data ?? []).filter((p) => !needle || [p.name, p.category, p.website, p.phone, p.emails.join(" ")].join(" ").toLowerCase().includes(needle)).slice(0, 8);

  // The date button filters the current workspace's leads by the day they came in.
  const leadsPath = isFinder ? "/finder/leads" : isBuilds ? "/builds/all" : isWp ? "/wp/all" : isSeo ? "/seo/all" : isCare ? "/care/all" : "/leads";
  const selectedDay = path === leadsPath ? params.get("date") : null;
  const shownDate = (selectedDay ? parseDayKey(selectedDay) : new Date()).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }).replace(",", ".");
  const perDay: Record<string, number> = {};
  for (const item of isFinder ? prospects.data ?? [] : isBuilds ? builds.data ?? [] : isWp ? conversions.data ?? [] : isSeo ? seoSites.data ?? [] : isCare ? careSites.data ?? [] : leads.data ?? []) perDay[dayKey(item.createdAt)] = (perDay[dayKey(item.createdAt)] ?? 0) + 1;
  const pickDay = (k: string | null) => {
    close();
    const next = new URLSearchParams(path === leadsPath ? params : undefined);
    if (k) next.set("date", k);
    else next.delete("date");
    nav(`${leadsPath}${next.toString() ? `?${next}` : ""}`);
  };

  const mode = settings.data?.mode ?? "session";
  const user = settings.data?.userName || "Studio Owner";
  const studio = settings.data?.studioName || "Studio";
  const brandUrl = (f?: string) => (f ? `/files/brand/${f}` : "");
  const brandColor = settings.data?.brandColor;
  useEffect(() => {
    if (brandColor) applyBrand(brandColor);
    // Remember name + colour so the desktop startup splash matches on the next launch.
    if (settings.data) desktop?.cacheBrand?.({ studioName: settings.data.studioName, brandColor });
  }, [brandColor, settings.data?.studioName]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    document.title = settings.data ? `${studio} · ${WORKSPACES.find((w) => w.key === workspace)!.label}` : "Mockup Studio";
  }, [studio, settings.data, workspace]);

  async function setMode(m: "session" | "api" | "cloud") {
    await api("/api/settings", { method: "PUT", json: { mode: m } });
    close();
    reloadAll();
  }

  const current = WORKSPACES.find((w) => w.key === workspace)!;
  const CurrentIcon = current.icon;

  return (
    <div className="frame">
      <header className="topbar">
        <button className={`logo-btn${settings.data?.logoFile ? " has-img" : ""}`} aria-label={`${studio} home`} onClick={() => nav(current.home)}>
          {settings.data?.logoFile ? <img src={brandUrl(settings.data.logoFile)} alt="" /> : <Logo />}
        </button>

        <div className="pop-anchor" ref={wsRef}>
          <button className="btn btn-chip ws-trigger" aria-haspopup="menu" aria-expanded={popover === "workspace"} onClick={() => setPopover(popover === "workspace" ? null : "workspace")}>
            <CurrentIcon /><span className="label-sm-hide">{current.label}</span>{!isComms && commsActivity && <span className="unread dot" aria-label="Unread messages" />}<ChevronDown className="dd-chevron" />
          </button>
          {popover === "workspace" && (
            <div className="popover menu" style={{ width: 230 }} role="menu" aria-label="Switch workspace">
              {WORKSPACES.map((w) => {
                const Icon = w.icon;
                return (
                  <button key={w.key} type="button" role="menuitemradio" aria-checked={w.key === workspace} className={`menu-item${w.key === workspace ? " on" : ""}`} onClick={() => { close(); nav(w.home); }}>
                    <span className="ws-icon"><Icon /></span>
                    <span className="menu-text"><b>{w.label}</b></span>
                    {w.key === "comms" && w.key !== workspace && commsActivity ? <span className="unread">{commsUnread || ""}</span> : w.key === workspace && <Check className="menu-check" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="pop-anchor" ref={searchRef}>
          <button className="btn btn-chip" onClick={() => setPopover(popover === "search" ? null : "search")}><Search /><span className="label-sm-hide">Search</span></button>
          {popover === "search" && (
            <div className="popover">
              <input className="input" placeholder={isComms ? "Search channels" : isSeo || isCare ? "Search sites" : isWp ? "Search conversions" : isBuilds ? "Search builds" : isFinder ? "Search businesses, phones, emails" : "Search leads, URLs, emails"} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
              <div className="search-results" style={{ marginTop: 8 }}>
                {isComms
                  ? commsResults.map((x) => (
                      <button key={x.id} className="notif" style={{ border: 0, background: "none", textAlign: "left", gridTemplateColumns: "minmax(0,1fr) auto" }} onClick={() => { close(); nav(`/comms/${x.id}`); }}>
                        <div><b>{x.name}</b><span>{host(x.url)}</span></div>
                        <UnreadBadge n={commsState[x.id]?.unread} muted={x.muted} />
                      </button>
                    ))
                  : isCare
                  ? careResults.map((x) => (
                      <button key={x.id} className="notif" style={{ border: 0, background: "none", textAlign: "left", gridTemplateColumns: "minmax(0,1fr)" }} onClick={() => { close(); nav(`/care/${x.id}`); }}>
                        <div><b>{x.name}</b><span>{host(x.siteUrl)} · {careState(x).label}</span></div>
                      </button>
                    ))
                  : isSeo
                  ? seoResults.map((x) => (
                      <button key={x.id} className="notif" style={{ border: 0, background: "none", textAlign: "left", gridTemplateColumns: "minmax(0,1fr)" }} onClick={() => { close(); nav(`/seo/${x.id}`); }}>
                        <div><b>{x.name}</b><span>{host(x.siteUrl)} · {x.pages.length} pages</span></div>
                      </button>
                    ))
                  : isWp
                  ? wpResults.map((c) => (
                      <button key={c.id} className="notif" style={{ border: 0, background: "none", textAlign: "left", gridTemplateColumns: "minmax(0,1fr)" }} onClick={() => { close(); nav(`/wp/${c.id}`); }}>
                        <div><b>{c.business}</b><span>{host(c.siteUrl)} · {c.pages.filter((p) => p.status === "approved").length}/{c.pages.length} pages approved</span></div>
                      </button>
                    ))
                  : isBuilds
                  ? buildResults.map((b) => (
                      <button key={b.id} className="notif" style={{ border: 0, background: "none", textAlign: "left", gridTemplateColumns: "minmax(0,1fr)" }} onClick={() => { close(); nav(`/builds/${b.id}`); }}>
                        <div><b>{b.business}</b><span>{b.pages.length} pages · {b.status.replace("_", " ")}</span></div>
                      </button>
                    ))
                  : isFinder
                  ? finderResults.map((p) => (
                      <button key={p.id} className="notif" style={{ border: 0, background: "none", textAlign: "left", gridTemplateColumns: "minmax(0,1fr)" }} onClick={() => { close(); nav(`/finder/leads/${p.id}`); }}>
                        <div><b>{p.name}</b><span>{p.category || "Business"}{p.website ? ` · ${host(p.website)}` : ""}</span></div>
                      </button>
                    ))
                  : mockupResults.map((l) => (
                      <button key={l.id} className="notif" style={{ border: 0, background: "none", textAlign: "left", gridTemplateColumns: "minmax(0,1fr) auto" }} onClick={() => { close(); nav(`/leads/${l.id}`); }}>
                        <div><b>{l.business || host(l.url)}</b><span>{host(l.url)} · {l.name || l.email || l.source}</span></div>
                        <StatusPill status={l.status} />
                      </button>
                    ))}
                {!(isComms ? commsResults : isCare ? careResults : isSeo ? seoResults : isWp ? wpResults : isBuilds ? buildResults : isFinder ? finderResults : mockupResults).length && <p className="side-empty" style={{ padding: 12 }}>No matches</p>}
              </div>
            </div>
          )}
        </div>

        <button className="btn btn-chip hide-sm" onClick={ctx.openAdd}>{isAdmin ? <Banknote /> : isComms ? <MessagesSquare /> : isCare ? <Server /> : isSeo ? <Gauge /> : isWp ? <PanelsTopLeft /> : isBuilds ? <FilePlus2 /> : isFinder ? <MapPinned /> : <UserPlus />}{isAdmin ? "Record payment" : isComms ? "Add channel" : isCare ? "Add site" : isSeo ? "Add live site" : isWp ? "New conversion" : isBuilds ? "New build" : isFinder ? "New search" : "Add lead"}</button>
        <span className="top-divider hide-sm" />

        <div className="pop-anchor" ref={notifRef}>
          <button className="btn btn-white btn-icon" aria-label="Notifications" title="Notifications" onClick={() => setPopover(popover === "notif" ? null : "notif")}><Bell /></button>
          {popover === "notif" && (
            <div className="popover">
              <div className="notif-list search-results">
                {(events.data ?? []).slice(0, 12).map((e) => (
                  <button key={e.id} className="notif" style={{ border: 0, background: "none", textAlign: "left" }} onClick={() => { close(); if (e.leadId) nav(`/leads/${e.leadId}`); else if (/lead search/i.test(e.title)) nav("/finder/searches"); }}>
                    <span className="tile"><EventIcon kind={e.kind} /></span>
                    <div><b>{e.title}</b><span>{e.detail}</span></div>
                    <span style={{ fontSize: 12 }} className="muted">{timeAgo(e.at)}</span>
                  </button>
                ))}
                {!events.data?.length && <p className="side-empty" style={{ padding: 12 }}>Nothing yet</p>}
              </div>
            </div>
          )}
        </div>

        <span className="spacer" />

        <div className="pop-anchor hide-sm" ref={modeRef}>
          <button className="lang" onClick={() => setPopover(popover === "mode" ? null : "mode")}>{mode === "api" ? "API" : mode === "cloud" ? "Cloud" : "Session"}<ChevronDown /></button>
          {popover === "mode" && (
            <div className="popover right" style={{ width: 300 }}>
              <button className="notif" style={{ border: 0, background: mode === "session" ? "#f6f5f5" : "none", textAlign: "left", width: "100%", gridTemplateColumns: "minmax(0,1fr)" }} onClick={() => setMode("session")}>
                <div><b>Session mode</b><span>Uses your Claude plan through Claude Code</span></div>
              </button>
              <button className="notif" style={{ border: 0, background: mode === "api" ? "#f6f5f5" : "none", textAlign: "left", width: "100%", gridTemplateColumns: "minmax(0,1fr)" }} onClick={() => setMode("api")}>
                <div><b>API mode</b><span>Billed per token with your API key</span></div>
              </button>
              <button className="notif" style={{ border: 0, background: mode === "cloud" ? "#f6f5f5" : "none", textAlign: "left", width: "100%", gridTemplateColumns: "minmax(0,1fr)" }} onClick={() => setMode("cloud")}>
                <div><b>Cloud mode</b><span>Runs on your claude.ai cloud sessions (set up in Settings)</span></div>
              </button>
            </div>
          )}
        </div>
        <div className="pop-anchor hide-sm" ref={dateRef}>
          <button className={`btn btn-white${selectedDay ? " is-active" : ""}`} aria-haspopup="dialog" aria-expanded={popover === "date"} onClick={() => setPopover(popover === "date" ? null : "date")}>
            <CalendarDays />{shownDate}
          </button>
          {popover === "date" && (
            <div className="popover right" style={{ width: 320 }} role="dialog" aria-label="Filter leads by day">
              <Calendar selected={selectedDay} counts={perDay} onSelect={pickDay} />
              <div className="cal-foot">
                <span className="muted">{selectedDay ? `${perDay[selectedDay] ?? 0} leads that day` : "Dots mark days with leads"}</span>
                <div style={{ display: "flex", gap: 8 }}>
                  {selectedDay && <button type="button" className="btn btn-chip btn-xs" onClick={() => pickDay(null)}>Clear</button>}
                  <button type="button" className="btn btn-ink btn-xs" onClick={() => pickDay(dayKey(new Date()))}>Today</button>
                </div>
              </div>
            </div>
          )}
        </div>
        <button className="btn btn-ink btn-wide" onClick={isCare ? () => nav("/care/all?show=approve") : isComms ? () => nav("/comms") : isAdmin ? () => nav("/admin/clients") : ctx.openAdd}>{isAdmin ? "Clients" : isComms ? (commsUnread ? `${commsUnread} unread` : "All channels") : isCare ? "Approvals" : isSeo ? "Audit a site" : isWp ? "Convert" : isBuilds ? "New build" : isFinder ? "Find leads" : "Create"} <ArrowRight /></button>
      </header>

      <div className={`shell${collapsed ? " is-collapsed" : ""}`}>
        <aside className={`sidebar${collapsed ? " collapsed" : ""}`} aria-label="Main navigation">
          <div className="side-top">
            <h2>{studio}</h2>
            <button type="button" className="collapse-btn" onClick={toggleSidebar} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
              {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </button>
          </div>

          {isAdmin ? (
            <>
              <NavLink to="/admin" end className="nav-item" title="Overview"><ChartColumn /><span className="label">Overview</span></NavLink>
              <NavLink to="/admin/clients" className="nav-item" title="Clients"><Contact /><span className="label">Clients</span></NavLink>
              <NavLink to="/admin/revenue" className="nav-item" title="Revenue"><Banknote /><span className="label">Revenue</span></NavLink>
              <NavLink to="/settings" className="nav-item" title="Settings"><SettingsIcon /><span className="label">Settings</span></NavLink>

              <div className="side-divider" />
              <div className="side-label"><span className="label">Workspaces</span></div>
              {WORKSPACES.filter((w) => w.key !== "admin").map((w) => (
                <NavLink key={w.key} to={w.home} className="vertical-item" title={w.label}>
                  <w.icon size={16} style={{ flex: "none", opacity: 0.85 }} />
                  <span className="name">{w.label}</span>
                </NavLink>
              ))}
            </>
          ) : isComms ? (
            <>
              <NavLink to="/comms" end className="nav-item" title="All channels"><Home /><span className="label">All channels</span>{commsActivity && <span className="count">{commsUnread || "•"}</span>}</NavLink>
              <NavLink to="/comms/new" className="nav-item" title="Add channel"><Plus /><span className="label">Add channel</span></NavLink>
              <NavLink to="/settings" className="nav-item" title="Settings"><SettingsIcon /><span className="label">Settings</span></NavLink>

              <div className="side-divider" />
              <div className="side-label"><span className="label">Channels</span></div>
              {(commsServices.data ?? []).map((x) => (
                <NavLink key={x.id} to={`/comms/${x.id}`} className="vertical-item ch-side" title={x.name}>
                  <ChannelTile svc={x} state={commsState[x.id]} size={22} />
                  <span className="name">{x.name}</span>
                  <UnreadBadge n={commsState[x.id]?.unread} muted={x.muted} />
                </NavLink>
              ))}
              {!commsServices.data?.length && <p className="side-empty">Channels you add show up here.</p>}
            </>
          ) : isCare ? (
            <>
              <NavLink to="/care" end className="nav-item" title="Dashboard"><Home /><span className="label">Dashboard</span></NavLink>
              <NavLink to="/care/all" end className="nav-item" title="Sites"><Server /><span className="label">Sites</span><span className="count">{careSites.data?.length ?? ""}</span></NavLink>
              <NavLink to="/care/all?show=approve" className="nav-item" title="Awaiting approval"><ClipboardCheck /><span className="label">Approvals</span><span className="count">{careSites.data?.filter((x) => x.run?.status === "waiting").length || ""}</span></NavLink>
              <NavLink to="/settings/maintenance" className="nav-item" title="Settings"><SettingsIcon /><span className="label">Settings</span></NavLink>

              <div className="side-divider" />
              <div className="side-label"><span className="label">Sites</span><button className="btn-ghost" style={{ border: 0, background: "none", padding: 0, display: "grid" }} aria-label="Add site" onClick={() => nav("/care/new")}><Plus size={16} color="var(--faint)" /></button></div>
              {(careSites.data ?? []).slice(0, 8).map((x) => (
                <NavLink key={x.id} to={`/care/${x.id}`} className="vertical-item" title={`${x.name} · ${careState(x).label}`}>
                  <span className="sq round" style={{ background: CARE_DOT[careState(x).key] }} />
                  <span className="name">{x.name}</span>
                </NavLink>
              ))}
              {!careSites.data?.length && <p className="side-empty">Sites you maintain show up here.</p>}
            </>
          ) : isSeo ? (
            <>
              <NavLink to="/seo" end className="nav-item" title="Dashboard"><Home /><span className="label">Dashboard</span></NavLink>
              <NavLink to="/seo/all" className="nav-item" title="Live sites"><Gauge /><span className="label">Live sites</span><span className="count">{seoSites.data?.length ?? ""}</span></NavLink>
              <NavLink to="/seo/checklist" className="nav-item" title="Checklist template"><ListChecks /><span className="label">Checklist</span></NavLink>
              <NavLink to="/settings" className="nav-item" title="Settings"><SettingsIcon /><span className="label">Settings</span></NavLink>

              <div className="side-divider" />
              <div className="side-label"><span className="label">Sites</span><button className="btn-ghost" style={{ border: 0, background: "none", padding: 0, display: "grid" }} aria-label="Add live site" onClick={() => nav("/seo/new")}><Plus size={16} color="var(--faint)" /></button></div>
              {(seoSites.data ?? []).slice(0, 6).map((x) => (
                <NavLink key={x.id} to={`/seo/${x.id}`} className="vertical-item" title={x.name}>
                  <span className="sq round" style={{ background: Object.values(x.runs).some((r) => r?.status === "running") ? "var(--amber)" : x.qaSignedOff ? "var(--green)" : "var(--faint)" }} />
                  <span className="name">{x.name}</span>
                </NavLink>
              ))}
              {!seoSites.data?.length && <p className="side-empty">Live sites you audit show up here.</p>}
            </>
          ) : isWp ? (
            <>
              <NavLink to="/wp" end className="nav-item" title="Dashboard"><Home /><span className="label">Dashboard</span></NavLink>
              <NavLink to="/wp/all" className="nav-item" title="Conversions"><PanelsTopLeft /><span className="label">Conversions</span><span className="count">{conversions.data?.length ?? ""}</span></NavLink>
              <NavLink to="/wp/new" className="nav-item" title="New conversion"><FilePlus2 /><span className="label">New conversion</span></NavLink>
              <NavLink to="/settings" className="nav-item" title="Settings"><SettingsIcon /><span className="label">Settings</span></NavLink>

              <div className="side-divider" />
              <div className="side-label"><span className="label">Recent sites</span><button className="btn-ghost" style={{ border: 0, background: "none", padding: 0, display: "grid" }} aria-label="New conversion" onClick={() => nav("/wp/new")}><Plus size={16} color="var(--faint)" /></button></div>
              {(conversions.data ?? []).slice(0, 6).map((c) => (
                <NavLink key={c.id} to={`/wp/${c.id}`} className="vertical-item" title={`${c.business} · ${c.status.replace("_", " ")}`}>
                  <span className="sq round" style={{ background: WP_DOT[c.status] }} />
                  <span className="name">{c.business}</span>
                </NavLink>
              ))}
              {!conversions.data?.length && <p className="side-empty">Builds you convert to WordPress show up here.</p>}
            </>
          ) : isBuilds ? (
            <>
              <NavLink to="/builds" end className="nav-item" title="Dashboard"><Home /><span className="label">Dashboard</span></NavLink>
              <NavLink to="/builds/all" className="nav-item" title="Builds"><Blocks /><span className="label">Builds</span><span className="count">{builds.data?.length ?? ""}</span></NavLink>
              <NavLink to="/builds/new" className="nav-item" title="New build"><FilePlus2 /><span className="label">New build</span></NavLink>
              <NavLink to="/settings" className="nav-item" title="Settings"><SettingsIcon /><span className="label">Settings</span></NavLink>

              <div className="side-divider" />
              <div className="side-label"><span className="label">Recent builds</span><button className="btn-ghost" style={{ border: 0, background: "none", padding: 0, display: "grid" }} aria-label="New build" onClick={() => nav("/builds/new")}><Plus size={16} color="var(--faint)" /></button></div>
              {(builds.data ?? []).slice(0, 6).map((b) => (
                <NavLink key={b.id} to={`/builds/${b.id}`} className="vertical-item" title={`${b.business} · ${b.status.replace("_", " ")}`}>
                  <span className="sq round" style={{ background: BUILD_DOT[b.status] }} />
                  <span className="name">{b.business}</span>
                </NavLink>
              ))}
              {!builds.data?.length && <p className="side-empty">Approved mockups you turn into sites show up here.</p>}
            </>
          ) : isFinder ? (
            <>
              <NavLink to="/finder" end className="nav-item" title="Dashboard"><Home /><span className="label">Dashboard</span></NavLink>
              <NavLink to="/finder/leads" className="nav-item" title="Leads"><Users /><span className="label">Leads</span><span className="count">{prospects.data?.length ?? ""}</span></NavLink>
              <NavLink to="/finder/searches" className="nav-item" title="Searches"><Radar /><span className="label">Searches</span></NavLink>
              <NavLink to="/settings" className="nav-item" title="Settings"><SettingsIcon /><span className="label">Settings</span></NavLink>

              <div className="side-divider" />
              <div className="side-label"><span className="label">Recent searches</span><button className="btn-ghost" style={{ border: 0, background: "none", padding: 0, display: "grid" }} aria-label="New search" onClick={() => setAdding(true)}><Plus size={16} color="var(--faint)" /></button></div>
              {(searches.data ?? []).slice(0, 6).map((s) => (
                <NavLink key={s.id} to={`/finder/leads?search=${s.id}`} className="vertical-item" title={s.query}>
                  <span className="sq" style={{ background: s.color }} />
                  <span className="name">{s.query}</span>
                </NavLink>
              ))}
              {!searches.data?.length && <p className="side-empty">Your searches will show up here.</p>}
            </>
          ) : (
            <>
              <NavLink to="/" end className="nav-item" title="Dashboard"><Home /><span className="label">Dashboard</span></NavLink>
              <NavLink to="/leads" className="nav-item" title="Leads"><Users /><span className="label">Leads</span><span className="count">{leads.data?.length ?? ""}</span></NavLink>
              <NavLink to="/benchmarks" className="nav-item" title="Benchmarks"><Layers /><span className="label">Benchmarks</span></NavLink>
              <NavLink to="/settings" className="nav-item" title="Settings"><SettingsIcon /><span className="label">Settings</span></NavLink>

              <div className="side-divider" />
              <div className="side-label"><span className="label">Verticals</span><button className="btn-ghost" style={{ border: 0, background: "none", padding: 0, display: "grid" }} aria-label="Open benchmarks" onClick={() => nav("/benchmarks")}><Plus size={16} color="var(--faint)" /></button></div>
              {(benchmarks.data ?? []).slice(0, 5).map((b) => (
                <NavLink key={b.vertical} to={`/leads?vertical=${b.vertical}`} className="vertical-item" title={b.label}>
                  <span className="sq" style={{ background: b.color }} />
                  <span className="name">{b.label}</span>
                </NavLink>
              ))}
              {!benchmarks.data?.length && <p className="side-empty">Verticals appear after the first lead is diagnosed.</p>}
            </>
          )}

          <div className="user-row">
            {settings.data?.avatarFile ? (
              <img className="avatar" src={brandUrl(settings.data.avatarFile)} alt="" />
            ) : (
              <span className="avatar">{user.split(" ").map((w) => w[0]).slice(0, 2).join("")}</span>
            )}
            <div className="who"><b>{user}</b><span>{settings.data?.userEmail || "Local workspace"}</span></div>
            <NavLink to="/settings/profile" aria-label="Edit profile" title="Edit profile" className="user-edit"><UserCog size={20} strokeWidth={1.6} /></NavLink>
          </div>
        </aside>

        <main className="content">
          <Outlet context={ctx} />
        </main>
      </div>

      <ZoomControl />
      <AgentDock onOverlay={setAgentOpen} />
      {adding && !isFinder && (
        <AddLeadModal
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false);
            reloadAll();
            nav(`/leads/${id}`);
          }}
        />
      )}
      {adding && isFinder && (
        <NewSearchModal
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            reloadAll();
            nav("/finder/searches");
          }}
        />
      )}
    </div>
  );
}
