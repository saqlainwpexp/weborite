import { useEffect, useState } from "react";
import { ArrowUpRight, CheckCircle2, Clock, Crown, Download, HelpCircle, KeyRound, Loader2, Sparkles, XCircle } from "lucide-react";
import { api } from "../lib/api";
import type { DemoState } from "../../../shared/demo";
import { BUY_URL } from "../../../shared/legal";
import { UnlockModal, useDemo } from "./Demo";

interface Status {
  bypass: boolean;
  licensed: boolean;
  status: string;
  demo: DemoState | null;
  license: { plan: string; expiresAt: string | null; customerName: string; customerEmail: string; keyHint: string; activatedAt: string | null; computer: string } | null;
}

/** The plans a customer can be on. Prices and features match the marketing site. */
const PLANS = [
  { id: "yearly", icon: Crown, name: "Studio — Yearly", price: "$490", per: "/year", blurb: "Every feature, best value. Two months free versus monthly.", recommended: true },
  { id: "monthly", icon: Sparkles, name: "Studio — Monthly", price: "$49", per: "/month", blurb: "Every feature, billed monthly. Cancel any time.", recommended: false },
] as const;

const PLAN_NAMES: Record<string, string> = { monthly: "Studio — Monthly", yearly: "Studio — Yearly", trial: "Trial", lifetime: "Studio — Lifetime" };
const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "—");

/** Settings → Billing: the plans, how to switch, and the invoice history. */
export function Billing() {
  const { refresh } = useDemo();
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState("");
  const [unlock, setUnlock] = useState(false);

  useEffect(() => { void api<Status>("/api/license/status").then(setS).catch((e: Error) => setErr(e.message)); }, []);

  if (!s) return <p className="muted">{err || <><Loader2 className="spin" /> Loading…</>}</p>;

  const lic = s.license;
  const demo = s.demo;
  const activeId = lic?.plan ?? (demo ? "trial" : "");
  // Which plan each card toggle reflects, and the current-plan summary line.
  const planLabel = (id: string) => PLAN_NAMES[id] ?? "Plan";

  const invoices = lic
    ? [{
        plan: planLabel(lic.plan),
        cycle: lic.plan === "yearly" ? "Yearly" : lic.plan === "monthly" ? "Monthly" : "One-off",
        date: lic.activatedAt,
        status: s.status === "active" ? "Active" : s.status === "expired" ? "Expired" : s.status === "disabled" ? "Disabled" : "Inactive",
      }]
    : [];

  const statusPill = (st: string) =>
    st === "Active" ? <span className="inv-status active"><CheckCircle2 />Active</span>
    : st === "Expired" || st === "Disabled" || st === "Inactive" ? <span className="inv-status bad"><XCircle />{st}</span>
    : <span className="inv-status prog"><Clock />{st}</span>;

  return (
    <div className="billing-grid">
      <div className="stack" style={{ gap: 18 }}>
        {/* Current plan */}
        <section className="set-section">
          <h3 className="set-title"><Crown />Current plan</h3>
          <div className="set-body" style={{ gap: 10 }}>
            {demo && !lic && (
              <div className="bill-plan on">
                <span className="bill-ico"><Sparkles /></span>
                <div className="bill-meta"><b>Free trial{demo.expired ? " — ended" : ""}</b><span>{demo.expired ? "Enter a license key to keep going." : `${demo.daysLeft} day${demo.daysLeft === 1 ? "" : "s"} left · every feature, with limits.`}</span></div>
                <span className={`switch${demo.expired ? "" : " on"}`} aria-hidden="true"><i /></span>
              </div>
            )}
            {PLANS.map((p) => {
              const on = activeId === p.id;
              return (
                <a key={p.id} className={`bill-plan${on ? " on" : ""}`} href={on ? BUY_URL : `${BUY_URL}?plan=${p.id}`} target="_blank" rel="noreferrer" title={on ? "Manage your plan" : `Switch to ${p.name}`}>
                  <span className="bill-ico"><p.icon /></span>
                  <div className="bill-meta">
                    <b>{p.name} · {p.price}{p.per} {p.recommended && !on && <span className="bill-tag">Best value</span>}</b>
                    <span>{p.blurb}</span>
                  </div>
                  <span className={`switch${on ? " on" : ""}`} aria-label={on ? "Current plan" : "Switch"}><i /></span>
                </a>
              );
            })}
            {lic && <p className="muted" style={{ margin: "2px 4px 0", fontSize: 13 }}>Licensed to {lic.customerName || lic.customerEmail || "you"} · key •••• {lic.keyHint || "····"} · renews/ends {day(lic.expiresAt)}.</p>}
          </div>
        </section>

        {/* Billing & invoicing */}
        <section className="set-section">
          <h3 className="set-title"><Download />Billing and invoicing <HelpCircle className="set-help" /></h3>
          <div className="bill-row">
            <div><b>Billing &amp; invoicing</b><span>Your invoices and receipts live in your billing account. Open it to download them as PDF.</span></div>
            <a className="btn btn-white" href={BUY_URL} target="_blank" rel="noreferrer"><Download />All invoices <ArrowUpRight /></a>
          </div>
        </section>

        {/* Invoicing history */}
        <section className="set-section">
          <h3 className="set-title"><Clock />Invoicing history <HelpCircle className="set-help" /></h3>
          {invoices.length ? (
            <div className="inv-table">
              <div className="inv-head"><span>Plan</span><span>Date</span><span>Status</span><span aria-hidden="true" /></div>
              {invoices.map((inv, i) => (
                <div key={i} className="inv-row">
                  <div className="inv-plan"><span className="bill-ico sm"><Crown /></span><div><b>{inv.plan}</b><small>{inv.cycle}</small></div></div>
                  <div className="inv-date">{inv.cycle}<small>{day(inv.date)}</small></div>
                  <div>{statusPill(inv.status)}</div>
                  <a className="inv-dl" href={BUY_URL} target="_blank" rel="noreferrer" aria-label="Open receipt"><Download /></a>
                </div>
              ))}
            </div>
          ) : (
            <div className="bill-row"><div><b>No invoices yet</b><span>You're on the free trial — it's free. Invoices appear here once you buy a license.</span></div>
              <button type="button" className="btn btn-ink" onClick={() => setUnlock(true)}><KeyRound />Enter license key</button>
            </div>
          )}
        </section>
      </div>

      {/* Subscription Overview */}
      <aside className="overview-panel">
        <div className="overview-stack">
          {(demo && !lic ? [{ id: "trial", name: "Free trial", price: "", per: "", blurb: `${demo.daysLeft} days left`, icon: Sparkles, recommended: false }, ...PLANS] : PLANS).map((p) => {
            const on = activeId === p.id;
            return (
              <div key={p.id} className={`overview-card${on ? " on" : " faded"}`}>
                <span className="bill-ico"><p.icon /></span>
                <div className="bill-meta"><b>{p.name}{p.price ? ` · ${p.price}${p.per}` : ""}</b><span>{p.blurb}</span></div>
                <span className={`switch${on ? " on" : ""}`} aria-hidden="true"><i /></span>
              </div>
            );
          })}
        </div>
        <div className="overview-copy">
          <h3>Subscription Overview</h3>
          <p>See how your current plan compares with the other options. Switch any time — your leads, mockups and sites stay exactly as they are.</p>
        </div>
      </aside>

      {unlock && <UnlockModal onClose={() => { setUnlock(false); void api<Status>("/api/license/status").then(setS).catch(() => {}); refresh(); }} />}
    </div>
  );
}
