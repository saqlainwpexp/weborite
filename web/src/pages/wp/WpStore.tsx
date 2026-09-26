import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, Loader2, Plus, ShoppingBag, Trash2, Upload, XCircle } from "lucide-react";
import type { WpConversion, WpPaymentKey, WpShippingZone, WpStore } from "../../../../shared/types";
import { api, timeAgo } from "../../lib/api";

const PAYMENTS: { key: WpPaymentKey; label: string; hint: string }[] = [
  { key: "stripe", label: "Stripe", hint: "Cards, Apple Pay, Google Pay" },
  { key: "paypal", label: "PayPal", hint: "The owner connects PayPal in WooCommerce" },
  { key: "mollie", label: "Mollie", hint: "iDEAL, Bancontact, cards…" },
  { key: "bacs", label: "Bank transfer", hint: "Paid by IBAN after ordering" },
  { key: "cod", label: "Cash on delivery", hint: "" },
];

type Form = Omit<WpStore, "stripe" | "mollie" | "catalog" | "run" | "live" | "enabled"> & {
  stripe: { test: boolean; publishable: string; secret: string };
  mollie: { test: boolean; key: string };
  shippingText: (WpShippingZone & { countriesText: string })[];
};

function toForm(s: WpStore): Form {
  return {
    country: s.country, address: s.address, city: s.city, postcode: s.postcode, currency: s.currency, email: s.email,
    payments: s.payments, bank: s.bank.length ? s.bank : [{ account_name: "", account_number: "", bank_name: "", sort_code: "", iban: "", bic: "" }],
    shipping: s.shipping,
    shippingText: (s.shipping.length ? s.shipping : [{ name: "Domestic", countries: [], rate: "", free_over: "" }]).map((z) => ({ ...z, countriesText: z.countries.join(", ") })),
    stripe: { test: s.stripe.test, publishable: s.stripe.publishable, secret: "" },
    mollie: { test: s.mollie.test, key: "" },
  };
}

export function StorePanel({ c, reload }: { c: WpConversion; reload: () => void }) {
  const store = c.store;
  const [form, setForm] = useState<Form | null>(store ? toForm(store) : null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; list?: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const run = store?.run;
  const running = run?.status === "running";

  // Pick up the saved values once the store exists (first enable), but never overwrite unsaved edits.
  useEffect(() => {
    if (store && (!form || !dirty)) setForm(toForm(store));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store?.catalog?.uploadedAt, store?.stripe.secretSet, store?.mollie.keySet, Boolean(store)]);

  async function act(kind: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(kind);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ ok: true, text: ok });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  if (!store?.enabled || !form) {
    return (
      <div className="card card-lg">
        <div className="run-bar">
          <div><b><ShoppingBag size={17} /> Online store (WooCommerce)</b><span className="muted">Installs WooCommerce, imports the products from a CSV, and sets up payments and shipping on this site.</span></div>
          <button className="btn btn-ink btn-sm" disabled={busy !== null} onClick={() => act("enable", () => api(`/api/wp/${c.id}/store`, { method: "PUT", json: { enabled: true } }))}><ShoppingBag />Make this a store</button>
        </div>
        {msg && !msg.ok && <p className="bad" style={{ marginTop: 10 }}>{msg.text}</p>}
      </div>
    );
  }

  const set = (patch: Partial<Form>) => { setForm({ ...form, ...patch }); setDirty(true); };
  const togglePay = (k: WpPaymentKey) => set({ payments: form.payments.includes(k) ? form.payments.filter((x) => x !== k) : [...form.payments, k] });
  const zone = (i: number, patch: Partial<Form["shippingText"][number]>) => set({ shippingText: form.shippingText.map((z, n) => (n === i ? { ...z, ...patch } : z)) });

  const save = () => act("save", async () => {
    await api(`/api/wp/${c.id}/store`, {
      method: "PUT",
      json: {
        enabled: true, country: form.country, address: form.address, city: form.city, postcode: form.postcode, currency: form.currency, email: form.email,
        payments: form.payments, stripe: form.stripe, mollie: form.mollie, bank: form.bank,
        shipping: form.shippingText.map((z) => ({ name: z.name, countries: z.countriesText, rate: z.rate, free_over: z.free_over })),
      },
    });
    setDirty(false);
    setForm({ ...form, stripe: { ...form.stripe, secret: "" }, mollie: { ...form.mollie, key: "" } });
  }, "Store settings saved.");

  const upload = async (f: File) => {
    const csv = await f.text();
    await act("csv", async () => {
      const r = await api<{ products: number; variations: number; errors: string[]; saved: boolean }>(`/api/wp/${c.id}/store/catalog`, { method: "POST", json: { csv, file: f.name } });
      if (!r.saved) throw new Error(r.errors[0] ?? "No products found in the file.");
      setMsg({
        ok: !r.errors.length,
        text: `${r.products} products${r.variations ? ` and ${r.variations} variations` : ""} ready to import.${r.errors.length ? ` ${r.errors.length} row${r.errors.length === 1 ? " was" : "s were"} skipped:` : ""}`,
        list: r.errors,
      });
    });
    if (file.current) file.current.value = "";
  };

  const hasZones = form.shippingText.some((z) => z.countriesText.trim());
  const canRun = c.connected?.ok && !running && !dirty && Boolean(form.country) && form.payments.length > 0;

  return (
    <div className="card card-lg store-panel">
      <div className="card-head">
        <div>
          <h3 className="card-title"><ShoppingBag size={18} /> Online store (WooCommerce)</h3>
          <p className="card-sub">Native WooCommerce: real products, cart, checkout and payment plugins. Running it again updates what it set up before.</p>
        </div>
        <button className="btn btn-ghost btn-sm" disabled={busy !== null || running} onClick={() => { if (confirm("Stop treating this site as a store? Nothing is removed from WordPress.")) void act("off", () => api(`/api/wp/${c.id}/store`, { method: "DELETE" })); }}>Turn off</button>
      </div>

      <h4 className="store-h">Store details</h4>
      <div className="store-grid">
        <label className="fld"><span>Country code</span><input className="input" placeholder="NL, or US:CA" value={form.country} onChange={(e) => set({ country: e.target.value })} /></label>
        <label className="fld"><span>Currency</span><input className="input" placeholder="EUR" maxLength={3} value={form.currency} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} /></label>
        <label className="fld wide"><span>Street address</span><input className="input" value={form.address} onChange={(e) => set({ address: e.target.value })} /></label>
        <label className="fld"><span>City</span><input className="input" value={form.city} onChange={(e) => set({ city: e.target.value })} /></label>
        <label className="fld"><span>Postcode</span><input className="input" value={form.postcode} onChange={(e) => set({ postcode: e.target.value })} /></label>
        <label className="fld wide"><span>Order emails sent from</span><input className="input" type="email" placeholder="shop@client.com" value={form.email} onChange={(e) => set({ email: e.target.value })} /></label>
      </div>

      <h4 className="store-h">Payments</h4>
      <div className="pay-list">
        {PAYMENTS.map((p) => (
          <label key={p.key} className={`pay-opt${form.payments.includes(p.key) ? " on" : ""}`}>
            <input type="checkbox" checked={form.payments.includes(p.key)} onChange={() => togglePay(p.key)} />
            <span><b>{p.label}</b>{p.hint && <small className="muted">{p.hint}</small>}</span>
          </label>
        ))}
      </div>
      {form.payments.includes("stripe") && (
        <div className="store-grid sub">
          <label className="fld"><span>Stripe publishable key</span><input className="input mono" placeholder="pk_…" value={form.stripe.publishable} onChange={(e) => set({ stripe: { ...form.stripe, publishable: e.target.value } })} /></label>
          <label className="fld"><span>Stripe secret key</span><input className="input mono" type="password" placeholder={store.stripe.secretSet ? "•••••••• saved" : "sk_…"} value={form.stripe.secret} onChange={(e) => set({ stripe: { ...form.stripe, secret: e.target.value } })} autoComplete="off" /></label>
          <label className="chk"><input type="checkbox" checked={form.stripe.test} onChange={(e) => set({ stripe: { ...form.stripe, test: e.target.checked } })} />Test mode</label>
          <small className="muted wide">Leave the keys empty to let the owner connect Stripe in WooCommerce instead.</small>
        </div>
      )}
      {form.payments.includes("mollie") && (
        <div className="store-grid sub">
          <label className="fld wide"><span>Mollie API key</span><input className="input mono" type="password" placeholder={store.mollie.keySet ? "•••••••• saved" : "live_… or test_…"} value={form.mollie.key} onChange={(e) => set({ mollie: { ...form.mollie, key: e.target.value } })} autoComplete="off" /></label>
          <label className="chk"><input type="checkbox" checked={form.mollie.test} onChange={(e) => set({ mollie: { ...form.mollie, test: e.target.checked } })} />Test mode</label>
        </div>
      )}
      {form.payments.includes("bacs") && (
        <div className="store-grid sub">
          <label className="fld"><span>Account holder</span><input className="input" value={form.bank[0].account_name} onChange={(e) => set({ bank: [{ ...form.bank[0], account_name: e.target.value }] })} /></label>
          <label className="fld"><span>Bank name</span><input className="input" value={form.bank[0].bank_name} onChange={(e) => set({ bank: [{ ...form.bank[0], bank_name: e.target.value }] })} /></label>
          <label className="fld"><span>IBAN</span><input className="input mono" value={form.bank[0].iban} onChange={(e) => set({ bank: [{ ...form.bank[0], iban: e.target.value }] })} /></label>
          <label className="fld"><span>BIC</span><input className="input mono" value={form.bank[0].bic} onChange={(e) => set({ bank: [{ ...form.bank[0], bic: e.target.value }] })} /></label>
        </div>
      )}

      <h4 className="store-h">Shipping (flat rate)</h4>
      <div className="zone-list">
        {form.shippingText.map((z, i) => (
          <div key={i} className="zone-row">
            <label className="fld"><span>Zone</span><input className="input" value={z.name} onChange={(e) => zone(i, { name: e.target.value })} /></label>
            <label className="fld"><span>Country codes</span><input className="input" placeholder="NL, BE" value={z.countriesText} onChange={(e) => zone(i, { countriesText: e.target.value })} /></label>
            <label className="fld"><span>Rate</span><input className="input" inputMode="decimal" placeholder="4.95" value={z.rate} onChange={(e) => zone(i, { rate: e.target.value })} /></label>
            <label className="fld"><span>Free over</span><input className="input" inputMode="decimal" placeholder="optional" value={z.free_over} onChange={(e) => zone(i, { free_over: e.target.value })} /></label>
            <button type="button" className="icon-btn" aria-label={`Remove zone ${z.name}`} onClick={() => set({ shippingText: form.shippingText.filter((_, n) => n !== i) })}><Trash2 size={16} /></button>
          </div>
        ))}
        <button type="button" className="btn btn-chip btn-sm" onClick={() => set({ shippingText: [...form.shippingText, { name: "", countries: [], countriesText: "", rate: "", free_over: "" }] })}><Plus />Add zone</button>
      </div>

      <h4 className="store-h">Products</h4>
      <div className="run-bar">
        <div>
          <b>{store.catalog ? `${store.catalog.products} products${store.catalog.variations ? ` · ${store.catalog.variations} variations` : ""}` : "No products yet"}</b>
          <span className="muted">{store.catalog ? `${store.catalog.file} · uploaded ${timeAgo(store.catalog.uploadedAt)}` : "Upload a CSV in WooCommerce's product format (up to 500 products). Image columns take image URLs."}</span>
        </div>
        <span className="row-actions">
          <a className="btn btn-chip btn-sm" href="/api/wp/store/template.csv"><Download />Template</a>
          <input ref={file} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          <button type="button" className="btn btn-white btn-sm" disabled={busy !== null || running} onClick={() => file.current?.click()}><Upload />{store.catalog ? "Replace CSV" : "Upload CSV"}</button>
        </span>
      </div>

      {msg && (
        <div className={`banner ${msg.ok ? "" : "err"}`} style={{ marginTop: 14 }}>
          {msg.ok ? <CheckCircle2 /> : <AlertTriangle />}
          <div>{msg.text}{msg.list && msg.list.length > 0 && <ul className="err-list">{msg.list.slice(0, 8).map((e) => <li key={e}>{e}</li>)}{msg.list.length > 8 && <li>…and {msg.list.length - 8} more</li>}</ul>}</div>
        </div>
      )}

      <div className="store-actions">
        <button className="btn btn-white" disabled={busy !== null || running || !dirty} onClick={() => void save()}>{busy === "save" ? "Saving…" : "Save settings"}</button>
        <button className="btn btn-ink" disabled={!canRun || busy !== null} onClick={() => act("run", () => api(`/api/wp/${c.id}/store/run`, { method: "POST" }), "Store setup started.")}>
          {running ? <Loader2 className="spin" /> : <ShoppingBag />}{store.run?.status === "done" ? "Run again" : "Set up the store"}
        </button>
        <span className="muted" style={{ fontSize: 13 }}>
          {dirty ? "Save your changes first." : !c.connected?.ok ? "Connect the site first (Connection card)." : !form.country ? "Add the store's country code." : !form.payments.length ? "Pick at least one payment method." : !hasZones ? "No shipping zones: WooCommerce will ask the owner to add one." : ""}
        </span>
      </div>

      {run && (
        <div className="store-run">
          <p className="store-run-head">
            {run.status === "running" ? <Loader2 className="spin" /> : run.status === "done" ? <CheckCircle2 className="ok" /> : <XCircle className="bad" />}
            <b>{run.status === "running" ? run.step || "Working…" : run.status === "done" ? `Store ready ${run.finishedAt ? timeAgo(run.finishedAt) : ""}` : run.status === "paused" ? "Waiting on you" : "Setup stopped"}</b>
            {run.total > 0 && <span className="muted">{run.imported}/{run.total} products imported</span>}
          </p>
          {run.error && <p className="bad" style={{ margin: "6px 0 0" }}>{run.error}</p>}
          {run.steps.length > 0 && (
            <div className="check-group" style={{ marginTop: 8 }}>
              {run.steps.map((s) => (
                <div key={s.label} className="check-item">
                  <span className="check-ico">{s.ok ? <CheckCircle2 className="ok" /> : <AlertTriangle className="warn" />}</span>
                  <div><b>{s.label}</b>{s.detail && <small className="muted">{s.detail}</small>}</div>
                  <span />
                </div>
              ))}
            </div>
          )}
          {run.errors.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary className="bad">{run.errors.length} product{run.errors.length === 1 ? "" : "s"} couldn't be imported</summary>
              <ul className="err-list">{run.errors.slice(0, 50).map((e, i) => <li key={i}><b>{e.name || e.sku}</b>: {e.error}</li>)}</ul>
            </details>
          )}
          {run.notes.map((n) => <p key={n} className="muted" style={{ fontSize: 13, margin: "8px 0 0" }}>{n}</p>)}
          {store.live?.pages.shop && run.status === "done" && (
            <p style={{ marginTop: 10, fontSize: 14 }}>
              <a className="ext-link" href={store.live.pages.shop.url} target="_blank" rel="noreferrer">Open the shop</a>
              {" · "}{store.live.products} products · {store.live.gateways.map((g) => g.title).join(", ") || "no payment methods on"} · {store.live.zones.length} shipping zone{store.live.zones.length === 1 ? "" : "s"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
