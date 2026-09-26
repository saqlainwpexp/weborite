import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, CalendarClock, CheckCircle2, KeyRound, Laptop, Loader2, RefreshCw, ShieldCheck, Sparkles, User } from "lucide-react";
import { api, timeAgo } from "../lib/api";
import { DEMO_LABELS, DEMO_LIMITS, type DemoKind, type DemoState } from "../../../shared/demo";
import { BUY_URL, PRICING_URL } from "../../../shared/legal";
import { UnlockModal, useDemo } from "./Demo";

interface Status {
  bypass: boolean;
  licensed: boolean;
  status: string;
  demo: DemoState | null;
  lastCheckAt: string | null;
  graceUntil: string | null;
  license: { plan: string; expiresAt: string | null; customerName: string; customerEmail: string; keyHint: string; activatedAt: string | null; computer: string } | null;
}

const PLAN_NAMES: Record<string, string> = { monthly: "Monthly", yearly: "Yearly", trial: "Trial", lifetime: "Lifetime" };
const KINDS = Object.keys(DEMO_LIMITS) as DemoKind[];
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
const daysUntil = (iso: string) => Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);

/** Settings → Plan & license: which plan this copy is on, what's left, and how to upgrade or move it. */
export function PlanLicense() {
  const { refresh } = useDemo();
  const [s, setS] = useState<Status | null>(null);
  const [busy, setBusy] = useState<"" | "check" | "deactivate">("");
  const [confirm, setConfirm] = useState(false);
  const [unlock, setUnlock] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(() => api<Status>("/api/license/status").then(setS).catch((e: Error) => setErr(e.message)), []);
  useEffect(() => { void load(); }, [load]);

  async function run(kind: "check" | "deactivate") {
    setBusy(kind);
    setErr("");
    try {
      if (kind === "check") setS(await api<Status>("/api/license/refresh", { method: "POST" }));
      else {
        await api("/api/license/deactivate", { method: "POST" });
        // Keep working: this copy carries on as the demo, with whatever allowances it has left.
        setS(await api<Status>("/api/license/demo", { method: "POST" }).catch(() => api<Status>("/api/license/status")));
        setConfirm(false);
      }
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  if (!s) return <p className="muted">{err || "Loading…"}</p>;

  if (s.bypass) {
    return (
      <section className="plan-card">
        <div className="plan-head"><span className="plan-icon"><ShieldCheck /></span><div><h3>Owner copy</h3><p className="muted">Licensing is switched off in this build. Never share this installer: customers get the normal build, which asks for a key.</p></div></div>
      </section>
    );
  }

  const lic = s.license;
  const demo = s.demo;
  const plan = lic ? `Studio · ${PLAN_NAMES[lic.plan] ?? "License"}` : "Demo";
  const state = s.licensed
    ? s.status === "active" ? { cls: "ready", text: "Active" } : { cls: "needs_review", text: `Can't reach the license server · works until ${s.graceUntil ? day(s.graceUntil) : "soon"}` }
    : lic ? { cls: "failed", text: s.status === "expired" ? "Expired" : s.status === "disabled" ? "Disabled" : "Not active" } : { cls: "queued", text: "Free demo" };
  const ends = lic?.expiresAt ? daysUntil(lic.expiresAt) : null;

  return (
    <>
      <section className="plan-card">
        <div className="plan-head">
          <span className="plan-icon">{lic ? <CheckCircle2 /> : <Sparkles />}</span>
          <div>
            <p className="plan-kicker">Your plan</p>
            <h3>{plan}</h3>
            <span className={`status ${state.cls}`}><span className="dot" />{state.text}</span>
          </div>
          <div className="plan-actions">
            {lic ? (
              <>
                <a className="btn btn-white" href={`${BUY_URL}${lic.plan === "monthly" ? "?plan=yearly" : ""}`} target="_blank" rel="noreferrer">
                  {lic.plan === "monthly" ? "Switch to yearly" : lic.plan === "trial" ? "Buy a license" : "Renew"} <ArrowUpRight />
                </a>
                <button type="button" className="btn btn-white" disabled={busy !== ""} onClick={() => void run("check")}>{busy === "check" ? <Loader2 className="spin" /> : <RefreshCw />} Check now</button>
              </>
            ) : (
              <>
                <a className="btn btn-white" href={PRICING_URL} target="_blank" rel="noreferrer">Compare plans <ArrowUpRight /></a>
                <a className="btn btn-white" href={BUY_URL} target="_blank" rel="noreferrer">Buy a license <ArrowUpRight /></a>
                <button type="button" className="btn btn-ink" onClick={() => setUnlock(true)}><KeyRound /> Enter license key</button>
              </>
            )}
          </div>
        </div>

        {lic && ends !== null && ends <= 14 && (
          <p className={`plan-note${ends < 0 ? " bad" : ""}`}>
            {ends < 0 ? `Your license ended on ${day(lic.expiresAt!)}.` : ends === 0 ? "Your license ends today." : `Your license ends in ${ends} ${ends === 1 ? "day" : "days"}, on ${day(lic.expiresAt!)}.`}{" "}
            <a href={BUY_URL} target="_blank" rel="noreferrer">Renew it</a> to keep every feature unlocked.
          </p>
        )}

        {lic && (
          <dl className="plan-facts">
            <div><dt><User /> Licensed to</dt><dd>{lic.customerName || "—"}{lic.customerEmail && <span>{lic.customerEmail}</span>}</dd></div>
            <div><dt><CalendarClock /> Valid until</dt><dd>{lic.expiresAt ? day(lic.expiresAt) : "No end date"}{lic.expiresAt && ends !== null && ends >= 0 && <span>{ends === 0 ? "Today" : `${ends} ${ends === 1 ? "day" : "days"} left`}</span>}</dd></div>
            <div><dt><KeyRound /> License key</dt><dd>•••• {lic.keyHint || "····"}<span>From your purchase email</span></dd></div>
            <div><dt><Laptop /> This computer</dt><dd>{lic.computer || "This PC"}{lic.activatedAt && <span>Activated {day(lic.activatedAt)} · checked {s.lastCheckAt ? timeAgo(s.lastCheckAt) : "never"}</span>}</dd></div>
          </dl>
        )}

        {!lic && demo && (
          <>
            <p className="muted plan-intro">Every feature, with an allowance for each kind of work. Allowances are counted for good: deleting something doesn't give it back.</p>
            <ul className="plan-allow">
              {KINDS.map((k) => {
                const used = DEMO_LIMITS[k] - demo.left[k];
                return (
                  <li key={k} className={demo.left[k] === 0 ? "out" : ""}>
                    <span>{DEMO_LABELS[k][1].replace(/^./, (c) => c.toUpperCase())}</span>
                    <span className="bar"><i style={{ width: `${(used / DEMO_LIMITS[k]) * 100}%` }} /></span>
                    <b>{demo.left[k] === 0 ? "Used up" : `${demo.left[k]} of ${DEMO_LIMITS[k]} left`}</b>
                  </li>
                );
              })}
            </ul>
            <p className="muted plan-intro">Also: up to {demo.results} businesses per search or campaign, and {demo.products} products per store.</p>
          </>
        )}
        {err && <p className="error-text">{err}</p>}
      </section>

      {!lic && (
        <section className="plan-card plan-upsell">
          <h3>What a Studio license unlocks</h3>
          <ul>
            <li>Unlimited mockups, searches and campaigns, up to 60 businesses per search</li>
            <li>Unlimited builds and WordPress conversions, stores up to 500 products</li>
            <li>SEO and maintenance for every client site, and every communication channel</li>
          </ul>
          <p className="muted">$49 a month, or $490 a year. Your leads, mockups and sites stay exactly as they are.</p>
        </section>
      )}

      {lic && (
        <section className="plan-card">
          <h3>Move to another computer</h3>
          <p className="muted">A license is active on one computer at a time. Deactivate it here, then enter the same key on the other computer. This copy carries on as the demo.</p>
          {confirm ? (
            <div className="plan-confirm">
              <p>Deactivate the license on <b>{lic.computer || "this computer"}</b>? Unlimited features stop here until you enter a key again.</p>
              <button type="button" className="btn btn-white" onClick={() => setConfirm(false)}>Keep it here</button>
              <button type="button" className="btn btn-danger" disabled={busy !== ""} onClick={() => void run("deactivate")}>{busy === "deactivate" ? <Loader2 className="spin" /> : null} Deactivate</button>
            </div>
          ) : (
            <button type="button" className="btn btn-white" onClick={() => setConfirm(true)}>Deactivate on this computer</button>
          )}
        </section>
      )}

      {unlock && <UnlockModal onClose={() => { setUnlock(false); void load(); }} />}
    </>
  );
}
