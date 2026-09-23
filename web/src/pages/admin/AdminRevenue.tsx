import { useEffect, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { Banknote, CalendarDays, Check, CircleDollarSign, Globe, Pencil, Plus, Repeat, Trash2, User, XCircle } from "lucide-react";
import type { Payment, Retainer, ServiceKind } from "../../../../shared/types";
import type { LayoutCtx } from "../../layout/Layout";
import { api, host, usePoll } from "../../lib/api";
import { Dropdown } from "../../components/Dropdown";
import { money } from "../../components/charts";
import { SERVICE_LABEL } from "./AdminOverview";

type Data = { payments: Payment[]; retainers: Retainer[]; currency: string; sites: { id: string; name: string; client: string; siteUrl: string }[] };
const CURRENCIES = ["USD", "GBP", "EUR", "PKR", "AED", "AUD", "CAD", "INR", "SAR"];
const blank = () => ({ date: new Date().toISOString().slice(0, 10), client: "", domain: "", service: "website" as ServiceKind, amount: "", status: "paid" as "paid" | "pending", note: "" });

export default function AdminRevenue() {
  const { reloadAll } = useOutletContext<LayoutCtx>();
  const [params, setParams] = useSearchParams();
  const { data: d, reload } = usePoll<Data>("/api/admin/payments", 20000);
  const [form, setForm] = useState(blank());
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen] = useState(params.get("new") === "1");
  const [show, setShow] = useState<"all" | "paid" | "pending">("all");
  const [fees, setFees] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (d) setFees(Object.fromEntries(d.sites.map((s) => [s.id, String(d.retainers.find((r) => r.careId === s.id)?.fee ?? "")])));
  }, [d?.retainers.length, d?.sites.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!d) return <p className="muted">Loading…</p>;
  const $ = (n: number) => money(n, d.currency);
  const list = d.payments.filter((p) => show === "all" || p.status === show);
  const paid = d.payments.filter((p) => p.status === "paid").reduce((a, p) => a + p.amount, 0);
  const pending = d.payments.filter((p) => p.status === "pending").reduce((a, p) => a + p.amount, 0);
  const mrr = d.retainers.filter((r) => r.active).reduce((a, r) => a + r.fee, 0);
  const set = (k: keyof ReturnType<typeof blank>) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ ok: true, text: ok });
      void reload();
      reloadAll();
      return true;
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
      return false;
    }
  }
  const close = () => {
    setOpen(false);
    setEditing(null);
    setForm(blank());
    if (params.get("new")) setParams({});
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = { ...form, amount: Number(form.amount) };
    const ok = await act(() => (editing ? api(`/api/admin/payments/${editing}`, { method: "PUT", json: body }) : api("/api/admin/payments", { method: "POST", json: body })), editing ? "Payment updated." : "Payment recorded.");
    if (ok) close();
  };

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><span>Super admin</span><span className="sep">/</span><span className="here">Revenue</span></nav>
      <div className="title-row">
        <h1 className="page-title">Revenue</h1>
        <div className="actions">
          <Dropdown label="Currency" value={d.currency} onChange={(c) => void act(() => api("/api/settings", { method: "PUT", json: { currency: c } }))} options={CURRENCIES.map((c) => ({ value: c, label: c }))} />
          <button className="btn btn-ink" onClick={() => { setEditing(null); setForm(blank()); setOpen(true); }}><Plus />Record payment</button>
        </div>
      </div>
      {msg && <div className={`banner${msg.ok ? "" : " err"}`} style={msg.ok ? { background: "#eaf4ee", color: "#2f6f4a" } : undefined}>{msg.ok ? <Check /> : <XCircle />}{msg.text}</div>}

      <div className="four three">
        {[
          { label: "Paid, all time", value: $(paid), icon: <CircleDollarSign /> },
          { label: "Waiting to be paid", value: $(pending), icon: <Banknote /> },
          { label: "Monthly retainers", value: $(mrr), icon: <Repeat /> },
        ].map((k) => <div key={k.label} className="card stat"><div className="top"><span className="tile">{k.icon}</span></div><div><b>{k.value}</b><span style={{ display: "block", marginTop: 8 }}>{k.label}</span></div></div>)}
      </div>

      {open && (
        <form className="card card-lg" onSubmit={save}>
          <h3 className="card-title">{editing ? "Edit payment" : "Record a payment"}</h3>
          <div className="set-grid" style={{ marginTop: 16 }}>
            <div className="set-field"><label htmlFor="p-client">Client</label><div className="input-icon"><User /><input id="p-client" className="input" value={form.client} onChange={set("client")} placeholder="Business or person" required autoFocus /></div></div>
            <div className="set-field"><label htmlFor="p-amount">Amount ({d.currency})</label><div className="input-icon"><CircleDollarSign /><input id="p-amount" className="input" type="number" min="0" step="0.01" value={form.amount} onChange={set("amount")} required /></div></div>
            <div className="set-field"><label htmlFor="p-service">For</label><Dropdown field id="p-service" label="Service" value={form.service} onChange={(v) => setForm({ ...form, service: v as ServiceKind })} options={Object.entries(SERVICE_LABEL).map(([value, label]) => ({ value, label }))} /></div>
            <div className="set-field"><label htmlFor="p-status">Status</label><Dropdown field id="p-status" label="Status" value={form.status} onChange={(v) => setForm({ ...form, status: v as "paid" | "pending" })} options={[{ value: "paid", label: "Paid" }, { value: "pending", label: "Invoiced, not paid yet" }]} /></div>
            <div className="set-field"><label htmlFor="p-date">Date</label><div className="input-icon"><CalendarDays /><input id="p-date" className="input" type="date" value={form.date} onChange={set("date")} required /></div></div>
            <div className="set-field"><label htmlFor="p-domain">Website (optional)</label><div className="input-icon"><Globe /><input id="p-domain" className="input" value={form.domain} onChange={set("domain")} placeholder="client-site.com" /></div><span className="hint">Links the payment to the client's leads, builds and sites.</span></div>
            <div className="set-field" style={{ gridColumn: "1 / -1" }}><label htmlFor="p-note">Note</label><input id="p-note" className="input" value={form.note} onChange={set("note")} placeholder="Invoice number, deposit, milestone…" /></div>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}><button className="btn btn-ink">{editing ? "Save changes" : "Record payment"}</button><button type="button" className="btn btn-chip" onClick={close}>Cancel</button></div>
        </form>
      )}

      <div className="grid-main">
        <div className="card card-lg">
          <div className="card-head">
            <div><h3 className="card-title">Payments</h3><p className="card-sub">{d.payments.length} recorded</p></div>
            <div className="seg" role="group" aria-label="Show">
              {(["all", "paid", "pending"] as const).map((k) => <button key={k} type="button" className={show === k ? "on" : ""} aria-pressed={show === k} onClick={() => setShow(k)}>{k === "all" ? "All" : k === "paid" ? "Paid" : "Unpaid"}</button>)}
            </div>
          </div>
          {list.length ? (
            <div className="table-wrap" style={{ marginTop: 12 }}><table className="table">
              <thead><tr><th>Date</th><th>Client</th><th className="hide-sm">For</th><th style={{ textAlign: "right" }}>Amount</th><th>Status</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id}>
                    <td className="mono-num">{new Date(p.date + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</td>
                    <td><b style={{ fontWeight: 450 }}>{p.client}</b>{(p.domain || p.note) && <small className="muted" style={{ display: "block" }}>{[p.domain, p.note].filter(Boolean).join(" · ")}</small>}</td>
                    <td className="hide-sm">{SERVICE_LABEL[p.service]}</td>
                    <td style={{ textAlign: "right" }} className="mono-num">{$(p.amount)}</td>
                    <td>{p.status === "paid" ? <span className="status ready"><span className="dot" />Paid</span> : <button type="button" className="btn btn-chip btn-xs" title="Mark as paid" onClick={() => void act(() => api(`/api/admin/payments/${p.id}`, { method: "PUT", json: { status: "paid" } }), "Marked as paid.")}><Check />Mark paid</button>}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button type="button" className="icon-btn sm" aria-label="Edit" onClick={() => { setEditing(p.id); setForm({ date: p.date, client: p.client, domain: p.domain, service: p.service, amount: String(p.amount), status: p.status, note: p.note }); setOpen(true); window.scrollTo({ top: 0 }); }}><Pencil /></button>
                      <button type="button" className="icon-btn sm" aria-label="Delete" onClick={() => { if (confirm(`Delete the ${$(p.amount)} payment from ${p.client}?`)) void act(() => api(`/api/admin/payments/${p.id}`, { method: "DELETE" })); }}><Trash2 /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : <div className="empty" style={{ padding: "36px 12px" }}><p>{d.payments.length ? "Nothing in this view." : "No payments yet. Record one to start tracking earnings."}</p></div>}
        </div>

        <div className="stack side-col">
          <div className="card">
            <h3 className="card-title">Maintenance retainers</h3>
            <p className="card-sub">Monthly fee per maintained site</p>
            {d.sites.length ? (
              <>
                <div className="retainer-list">
                  {d.sites.map((s) => (
                    <form key={s.id} className="retainer-row" onSubmit={(e) => { e.preventDefault(); void act(() => api(`/api/admin/retainers/${s.id}`, { method: "PUT", json: { fee: Number(fees[s.id] || 0) } }), `Retainer for ${s.name} saved.`); }}>
                      <span className="search-main"><b>{s.client || s.name}</b><small>{host(s.siteUrl)}</small></span>
                      <input className="input" type="number" min="0" step="1" aria-label={`Monthly fee for ${s.name}`} placeholder="0" value={fees[s.id] ?? ""} onChange={(e) => setFees({ ...fees, [s.id]: e.target.value })} />
                      <button className="btn btn-chip btn-xs">Save</button>
                    </form>
                  ))}
                </div>
                <button className="btn btn-chip btn-sm" style={{ marginTop: 14 }} disabled={!mrr} onClick={() => void act(async () => {
                  const r = await api<{ added: number }>("/api/admin/retainers/bill", { method: "POST" });
                  setMsg({ ok: true, text: r.added ? `Added ${r.added} retainer invoice${r.added === 1 ? "" : "s"} for this month (unpaid).` : "This month's retainer invoices already exist." });
                })}><Repeat />Invoice this month's retainers</button>
              </>
            ) : <p className="muted" style={{ marginTop: 10, fontSize: 14 }}>Sites you add to Maintenance appear here.</p>}
          </div>
        </div>
      </div>
    </>
  );
}
