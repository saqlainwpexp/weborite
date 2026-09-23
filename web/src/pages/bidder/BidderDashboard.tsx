import { useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { ArrowRight, CircleCheck, ClipboardCheck, Pause, Play, RefreshCw, SkipForward, TriangleAlert, XCircle } from "lucide-react";
import type { LayoutCtx } from "../../layout/Layout";
import { api, timeAgo } from "../../lib/api";
import { BidProjectsTable } from "../../components/bidder";

export default function BidderDashboard() {
  const { bidProjects, bidder, reloadAll } = useOutletContext<LayoutCtx>();
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cfg = bidder?.config;
  const st = bidder?.stats;
  const poll = bidder?.poller;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      reloadAll();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const toggle = () => run(() => api("/api/bidder/config", { method: "PUT", json: { enabled: !cfg?.enabled } }));
  const checkNow = () => run(() => api("/api/bidder/poll", { method: "POST" }));

  const stats = [
    { label: "To review", value: st?.ready, sub: cfg?.mode === "auto" ? "Waiting after the daily limit" : "Drafted, waiting for you", icon: <ClipboardCheck /> },
    { label: "Bids today", value: st?.bidToday, sub: `Limit ${cfg?.dailyBidLimit ?? "–"} a day`, icon: <CircleCheck /> },
    { label: "Bids placed", value: st?.bidTotal, sub: "All time", icon: <ArrowRight /> },
    { label: "Skipped", value: st?.skipped, sub: "Filters or Claude said no", icon: <SkipForward /> },
  ];
  const toReview = (bidProjects ?? []).filter((p) => p.status === "ready");
  const latest = (bidProjects ?? []).filter((p) => p.status !== "skipped").slice(0, 8);

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span>Freelancer Bids</span><span className="sep">/</span><span className="here">Dashboard</span></nav>
      <div className="title-row">
        <h1 className="page-title">Overview</h1>
        <div className="actions">
          <button className="btn btn-white" disabled={busy || !cfg?.tokenSet} onClick={checkNow}><RefreshCw />Check now</button>
          <button className="btn btn-ink" disabled={busy || !cfg?.tokenSet} onClick={toggle}>{cfg?.enabled ? <><Pause />Pause bidder</> : <><Play />Start bidder</>}</button>
        </div>
      </div>

      {bidder && !cfg?.tokenSet && (
        <div className="banner"><TriangleAlert />Add your Freelancer access token and pick your skills in <button className="link-btn" onClick={() => nav("/bidder/settings")}>Bid settings</button> to get started.</div>
      )}
      {cfg?.tokenSet && cfg.env === "sandbox" && <div className="banner"><TriangleAlert />Sandbox mode: projects and bids come from freelancer-sandbox.com, so nothing real is sent. Switch to Live in Bid settings when you're ready.</div>}
      {poll?.lastError && <div className="banner err"><XCircle />{poll.lastError}</div>}
      {err && <div className="banner err"><XCircle />{err}</div>}

      <div className="grid-main">
        <div className="stack">
          <div className="four">
            {stats.map((s) => (
              <div key={s.label} className="card stat">
                <div className="top"><span className="tile">{s.icon}</span></div>
                <div>
                  <b>{st ? s.value : "–"}</b>
                  <span style={{ display: "block", marginTop: 8 }}>{s.label}</span>
                  <small className="muted" style={{ fontSize: 13 }}>{s.sub}</small>
                </div>
              </div>
            ))}
          </div>

          <div className="card card-lg">
            <div className="card-head" style={{ marginBottom: 20 }}>
              <div>
                <h3 className="card-title">Latest projects</h3>
                <p className="card-sub">Matching projects and where each bid stands</p>
              </div>
              <button className="btn btn-chip btn-sm" onClick={() => nav("/bidder/projects")}>View all</button>
            </div>
            <BidProjectsTable projects={latest} />
          </div>
        </div>

        <div className="stack side-col">
          <div className="card">
            <h3 className="card-title">Bidder</h3>
            <p className="card-sub">{cfg?.enabled ? `On · checks every ${cfg.pollMinutes} min` : "Paused"}</p>
            <dl className="fields">
              <div className="field"><dt>Mode</dt><dd>{cfg?.mode === "auto" ? "Automatic: bids go out on their own" : "Review: you approve each bid"}</dd></div>
              <div className="field"><dt>Account</dt><dd>{cfg?.user ? `${cfg.user.displayName} (@${cfg.user.username}) · ${cfg.env === "live" ? "Live" : "Sandbox"}` : "Not connected"}</dd></div>
              <div className="field"><dt>Skills</dt><dd>{cfg?.skills.length ? cfg.skills.map((s) => s.name).join(", ") : "None picked (searches every project)"}</dd></div>
              <div className="field"><dt>Last check</dt><dd>{poll?.lastPollAt ? `${timeAgo(poll.lastPollAt)} · ${poll.lastFound} new` : "Not yet"}</dd></div>
            </dl>
            <div className="notif-foot">
              <button className="btn btn-ink btn-sm" onClick={() => nav("/bidder/settings")}>Bid settings <ArrowRight /></button>
            </div>
          </div>

          <div className="card">
            <h3 className="card-title">Waiting for you</h3>
            <p className="card-sub">Proposals Claude drafted</p>
            <div className="search-list">
              {toReview.slice(0, 6).map((p) => (
                <button key={p.id} type="button" className="search-row" style={{ gridTemplateColumns: "minmax(0,1fr) auto" }} onClick={() => nav(`/bidder/projects/${p.id}`)}>
                  <span className="search-main"><b>{p.title}</b><small>{p.bidCount} bids · posted {timeAgo(p.postedAt)}</small></span>
                  <span className="btn btn-chip btn-xs">Review</span>
                </button>
              ))}
              {!toReview.length && <p className="side-empty" style={{ padding: "8px 0" }}>Nothing to review right now.</p>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
