import { useEffect, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { ExternalLink, RefreshCw, Save, Send, SkipForward, Trash2, XCircle } from "lucide-react";
import type { BidProject } from "../../../../shared/types";
import type { LayoutCtx } from "../../layout/Layout";
import { api, timeAgo, usePoll } from "../../lib/api";
import { BidStatusPill, budgetText, money } from "../../components/bidder";
import { Field } from "../../components/builds";

export default function BidderProject() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { bidder, reloadAll } = useOutletContext<LayoutCtx>();
  const { data: p, error, reload } = usePoll<BidProject>(`/api/bidder/projects/${id}`, 3000);
  const [proposal, setProposal] = useState("");
  const [amount, setAmount] = useState("");
  const [days, setDays] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Load the draft into the form when it first arrives or Claude rewrites it (unless you're mid-edit).
  const draftAt = p?.draft?.at;
  useEffect(() => {
    if (!p || dirty) return;
    setProposal(p.proposal ?? p.draft?.proposal ?? "");
    setAmount(p.amount != null ? String(p.amount) : "");
    setDays(String(p.days ?? p.draft?.days ?? 7));
  }, [p?.id, draftAt, p?.status, p?.amount, dirty]);

  if (error && !p) return <div className="banner err"><XCircle />{error}</div>;
  if (!p) return <p className="muted">Loading…</p>;

  const factor = bidder?.config.openBudgetFactor ?? 1.3;
  const lo = Math.ceil(p.budget.min);
  const hi = Math.floor(p.budget.max && p.budget.max >= p.budget.min ? p.budget.max : p.budget.min * factor);
  const sent = p.status === "bid" || p.status === "bidding";
  const working = p.status === "new" || p.status === "drafting";
  const unit = p.type === "hourly" ? "/hr" : "";
  const amt = Number(amount);
  const outside = amount !== "" && (amt < lo || amt > hi);

  async function act(kind: "save" | "bid" | "redraft" | "skip" | "delete") {
    setBusy(kind);
    setErr(null);
    try {
      if (kind === "delete") {
        if (!confirm("Remove this project from the list? If it comes up in a search again, it will be treated as new.")) return;
        await api(`/api/bidder/projects/${p!.id}`, { method: "DELETE" });
        reloadAll();
        nav("/bidder/projects");
        return;
      }
      if (kind === "bid" && !confirm(`Place a ${money(p!, Math.min(hi, Math.max(lo, amt)))}${unit} bid on “${p!.title}”${bidder?.config.env === "sandbox" ? " (sandbox)" : ""}?`)) return;
      if (kind === "save" || kind === "bid") {
        await api(`/api/bidder/projects/${p!.id}`, { method: "PUT", json: { proposal, amount: amount === "" ? undefined : amt, days: Number(days) } });
        setDirty(false);
      }
      if (kind === "bid") await api(`/api/bidder/projects/${p!.id}/bid`, { method: "POST" });
      if (kind === "redraft") {
        setDirty(false);
        await api(`/api/bidder/projects/${p!.id}/redraft`, { method: "POST" });
      }
      if (kind === "skip") await api(`/api/bidder/projects/${p!.id}/skip`, { method: "POST" });
      void reload();
      reloadAll();
    } catch (e) {
      setErr((e as Error).message);
      void reload();
    } finally {
      setBusy(null);
    }
  }

  const edit = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    setDirty(true);
  };

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/bidder/projects">Projects</Link><span className="sep">/</span><span className="here">{p.title}</span>
      </nav>
      <div className="title-row">
        <div>
          <h1 className="page-title">{p.title}</h1>
          <p className="muted" style={{ marginTop: 8 }}>{p.type === "hourly" ? "Hourly" : "Fixed price"} · {budgetText(p)} · posted {timeAgo(p.postedAt)}</p>
        </div>
        <div className="actions">
          <BidStatusPill status={p.status} />
          <a className="btn btn-white" href={p.url} target="_blank" rel="noreferrer"><ExternalLink />Open on Freelancer</a>
        </div>
      </div>

      {p.note && <div className={`banner${p.status === "failed" ? " err" : ""}`}><XCircle />{p.note}</div>}
      {err && <div className="banner err"><XCircle />{err}</div>}

      <div className="grid-main">
        <div className="stack">
          <div className="card card-lg">
            <div className="card-head" style={{ marginBottom: 16 }}>
              <div>
                <h3 className="card-title">{sent ? "Your bid" : "Proposal"}</h3>
                <p className="card-sub">{working ? "Claude is writing the proposal…" : p.status === "bid" ? `Sent ${timeAgo(p.bidAt)}` : "Edit anything before you send it"}</p>
              </div>
              {!sent && !working && <button className="btn btn-chip btn-sm" disabled={busy !== null} onClick={() => act("redraft")}><RefreshCw />Rewrite</button>}
            </div>
            <div className="set-stack" style={{ gap: 12 }}>
              <Field label="Proposal" htmlFor="bp-text" hint={`${proposal.trim().length} characters · Freelancer expects at least 100`}>
                <textarea id="bp-text" className="input textarea" rows={12} value={proposal} readOnly={sent || working} onChange={(e) => edit(setProposal)(e.target.value)} />
              </Field>
              <div className="set-grid">
                <Field label={`Bid amount (${p.currency.code}${unit})`} htmlFor="bp-amt" hint={outside ? `Outside the client's range; it will be kept within ${money(p, lo)}–${money(p, hi)}` : `Client's range ${money(p, lo)}–${money(p, hi)}${p.budget.max ? "" : " (no maximum given)"}`}>
                  <input id="bp-amt" className="input" type="number" min={lo} max={hi} value={amount} readOnly={sent || working} onChange={(e) => edit(setAmount)(e.target.value)} />
                  {!sent && !working && hi > lo && <input type="range" min={lo} max={hi} step={1} value={amount === "" ? lo : Math.min(hi, Math.max(lo, amt))} onChange={(e) => edit(setAmount)(e.target.value)} aria-label="Bid amount within the client's range" />}
                </Field>
                <Field label="Delivery (days)" htmlFor="bp-days">
                  <input id="bp-days" className="input" type="number" min={1} max={365} value={days} readOnly={sent || working} onChange={(e) => edit(setDays)(e.target.value)} />
                </Field>
              </div>
            </div>
            {!sent && !working && (
              <div className="set-actions" style={{ marginTop: 18, flexWrap: "wrap" }}>
                <button className="btn btn-ink" disabled={busy !== null || proposal.trim().length < 100 || amount === ""} onClick={() => act("bid")}><Send />{busy === "bid" ? "Sending…" : "Place bid"}</button>
                <button className="btn btn-white" disabled={busy !== null || !dirty} onClick={() => act("save")}><Save />Save</button>
                {p.status !== "skipped" && <button className="btn btn-chip" disabled={busy !== null} onClick={() => act("skip")}><SkipForward />Skip</button>}
              </div>
            )}
          </div>

          <div className="card card-lg">
            <h3 className="card-title">Project description</h3>
            <p style={{ whiteSpace: "pre-wrap", marginTop: 12, lineHeight: 1.6 }}>{p.description || "No description."}</p>
          </div>
        </div>

        <div className="stack side-col">
          <div className="card">
            <h3 className="card-title">Details</h3>
            <dl className="fields">
              <div className="field"><dt>Budget</dt><dd>{budgetText(p)}</dd></div>
              <div className="field"><dt>Bids so far</dt><dd>{p.bidCount}{p.bidAvg ? ` · average ${money(p, Math.round(p.bidAvg))}${unit}` : ""}</dd></div>
              <div className="field"><dt>Client</dt><dd>{p.client.username ? `@${p.client.username}` : "Unknown"}{p.client.country ? ` · ${p.client.country}` : ""}</dd></div>
              <div className="field"><dt>Payment</dt><dd>{p.client.paymentVerified ? "Verified" : "Not verified"}</dd></div>
              <div className="field"><dt>Client rating</dt><dd>{p.client.rating != null && p.client.reviews ? `${p.client.rating.toFixed(1)} ★ (${p.client.reviews} reviews)` : "No reviews yet"}</dd></div>
              <div className="field"><dt>Skills</dt><dd>{p.skills.join(", ") || "–"}</dd></div>
            </dl>
          </div>

          {p.draft && (
            <div className="card">
              <h3 className="card-title">Claude's read</h3>
              <dl className="fields">
                <div className="field"><dt>Verdict</dt><dd>{p.draft.shouldBid ? "Worth a bid" : "Not a fit"}{p.draft.reason ? `: ${p.draft.reason}` : ""}</dd></div>
                <div className="field"><dt>Complexity</dt><dd>{Math.round(p.draft.complexity * 10)} / 10 (sets where in the range the bid lands)</dd></div>
                <div className="field"><dt>Suggested delivery</dt><dd>{p.draft.days} days</dd></div>
              </dl>
            </div>
          )}

          <button className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }} disabled={busy !== null || p.status === "bidding"} onClick={() => act("delete")}><Trash2 />Remove from list</button>
        </div>
      </div>
    </>
  );
}
