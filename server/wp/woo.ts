import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addEvent, sqlite as db } from "../db.ts";
import { open, seal } from "../vault.ts";
import type { WpConversion, WpStore } from "../../shared/types.ts";
import { WpError, ping, wooProducts, wooSetup, wooStatus, type WpAuth } from "./client.ts";
import { convDir, getConversion, getSecrets, saveConversion } from "./store.ts";
import { demoCap } from "../license/index.ts";
import { DEMO_PRODUCTS } from "../../shared/demo.ts";

/**
 * WooCommerce stores (phase 1): store settings, the product catalogue from a CSV, and the job that installs
 * and configures WooCommerce on the site and imports the products through the connector's woo.php.
 */

export const MAX_PRODUCTS = 500;
const BATCH = 20;

/* ---------- secrets (Stripe secret key, Mollie API key) ---------- */

db.exec(`CREATE TABLE IF NOT EXISTS wp_store_secrets (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);

type StoreSecrets = { stripeSecret?: string; mollieKey?: string };
function readSecrets(id: string): StoreSecrets {
  const r = db.prepare("SELECT data FROM wp_store_secrets WHERE id = ?").get(id) as { data: string } | undefined;
  return r ? (JSON.parse(open(r.data)) as StoreSecrets) : {};
}
function writeSecrets(id: string, s: StoreSecrets) {
  db.prepare("INSERT INTO wp_store_secrets (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(id, seal(JSON.stringify(s)));
}

export function defaultStore(): WpStore {
  return {
    enabled: true, country: "", address: "", city: "", postcode: "", currency: "EUR", email: "",
    payments: ["stripe", "paypal", "mollie", "bacs", "cod"],
    stripe: { test: true, publishable: "", secretSet: false },
    mollie: { test: true, keySet: false },
    bank: [],
    shipping: [],
    catalog: null, run: null, live: null,
  };
}

const PAYMENTS = ["stripe", "paypal", "mollie", "bacs", "cod"] as const;
const str = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);

/** Apply the store form. Secret fields are only replaced when a new value is sent. */
export function updateStore(c: WpConversion, body: Record<string, unknown>) {
  const s = c.store ?? defaultStore();
  s.enabled = body.enabled !== false;
  s.country = str(body.country, 10).toUpperCase();
  s.address = str(body.address);
  s.city = str(body.city, 100);
  s.postcode = str(body.postcode, 20);
  s.currency = str(body.currency, 3).toUpperCase() || "EUR";
  s.email = str(body.email, 200);
  s.payments = Array.isArray(body.payments) ? PAYMENTS.filter((p) => (body.payments as unknown[]).includes(p)) : s.payments;
  const stripe = (body.stripe ?? {}) as Record<string, unknown>;
  const mollie = (body.mollie ?? {}) as Record<string, unknown>;
  s.stripe = { test: stripe.test !== false, publishable: str(stripe.publishable, 300), secretSet: s.stripe.secretSet };
  s.mollie = { test: mollie.test !== false, keySet: s.mollie.keySet };
  const secrets = readSecrets(c.id);
  if (typeof stripe.secret === "string" && stripe.secret.trim()) secrets.stripeSecret = stripe.secret.trim();
  if (typeof mollie.key === "string" && mollie.key.trim()) secrets.mollieKey = mollie.key.trim();
  writeSecrets(c.id, secrets);
  s.stripe.secretSet = Boolean(secrets.stripeSecret);
  s.mollie.keySet = Boolean(secrets.mollieKey);
  s.bank = (Array.isArray(body.bank) ? body.bank : []).slice(0, 5).map((a: Record<string, unknown>) => ({
    account_name: str(a.account_name), account_number: str(a.account_number, 60), bank_name: str(a.bank_name),
    sort_code: str(a.sort_code, 30), iban: str(a.iban, 40).replace(/\s+/g, ""), bic: str(a.bic, 20),
  })).filter((a) => a.iban || a.account_number);
  s.shipping = (Array.isArray(body.shipping) ? body.shipping : []).slice(0, 20).map((z: Record<string, unknown>) => ({
    name: str(z.name, 80) || "Shipping",
    countries: (Array.isArray(z.countries) ? z.countries : String(z.countries ?? "").split(/[\s,]+/)).map((x) => str(x, 2).toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x)),
    rate: str(z.rate, 12).replace(",", "."),
    free_over: str(z.free_over, 12).replace(",", "."),
  })).filter((z) => z.countries.length);
  c.store = s;
  saveConversion(c);
  return c;
}

/* ---------- CSV (WooCommerce's own product export columns) ---------- */

export interface CsvProduct {
  type: "simple" | "variable" | "variation";
  sku: string;
  name: string;
  parent_sku?: string;
  regular_price: string;
  sale_price: string;
  categories: string; // "A > B | C"
  images: string[];
  description: string;
  short_description: string;
  stock: string;
  attributes: { name: string; values: string[] }[];
}

/** RFC 4180: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

/** WooCommerce escapes commas inside list values as "\,". Split on the rest. */
const splitList = (v: string) => v.split(/(?<!\\),/).map((x) => x.replace(/\\,/g, ",").trim()).filter(Boolean);

export const CSV_TEMPLATE = [
  ["Type", "SKU", "Name", "Parent", "Regular price", "Sale price", "Categories", "Images", "Short description", "Description", "Stock", "Attribute 1 name", "Attribute 1 value(s)", "Attribute 2 name", "Attribute 2 value(s)"],
  ["simple", "MUG-01", "Stoneware mug", "", "14.95", "", "Kitchen > Mugs", "https://example.com/mug.jpg", "Hand-glazed, 350 ml", "", "25", "", "", "", ""],
  ["variable", "TEE-01", "Organic T-shirt", "", "", "", "Clothing > T-shirts", "https://example.com/tee.jpg", "100% organic cotton", "", "", "Size", "S, M, L", "Colour", "Black, White"],
  ["variation", "TEE-01-S-BLK", "", "TEE-01", "24.95", "19.95", "", "", "", "", "10", "Size", "S", "Colour", "Black"],
].map((r) => r.map((x) => (/[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)).join(",")).join("\n") + "\n";

/** Read a WooCommerce-style product CSV. Returns products (variables before their variations) and row errors. */
export function readCatalog(text: string): { products: CsvProduct[]; errors: string[] } {
  const rows = parseCsv(text);
  if (rows.length < 2) return { products: [], errors: ["The CSV has no product rows."] };
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const idx = {
    type: col("type"), sku: col("sku"), name: col("name"), parent: col("parent"),
    regular: col("regular price", "price"), sale: col("sale price"), cats: col("categories", "category"),
    images: col("images", "image"), short: col("short description"), desc: col("description"), stock: col("stock"),
  };
  if (idx.name < 0 && idx.sku < 0) return { products: [], errors: ['Columns not recognised. Use the template, or WooCommerce\'s own product export ("Name", "SKU", "Regular price"…).'] };
  const attrCols: { name: number; values: number }[] = [];
  for (let n = 1; n <= 6; n++) {
    const name = col(`attribute ${n} name`);
    const values = col(`attribute ${n} value(s)`, `attribute ${n} values`, `attribute ${n} value`);
    if (name >= 0 && values >= 0) attrCols.push({ name, values });
  }
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  const products: CsvProduct[] = [];
  const errors: string[] = [];
  rows.slice(1).forEach((r, n) => {
    const line = n + 2;
    const rawType = get(r, idx.type).toLowerCase();
    const type: CsvProduct["type"] = rawType.includes("variation") ? "variation" : rawType.includes("variable") ? "variable" : "simple";
    const sku = get(r, idx.sku);
    const name = get(r, idx.name);
    const parent = get(r, idx.parent).replace(/^id:\d+$/, "");
    const regular = get(r, idx.regular).replace(",", ".");
    if (type !== "variation" && !name) return errors.push(`Row ${line}: no product name.`);
    if (type === "variation" && !parent) return errors.push(`Row ${line}: a variation needs the parent product's SKU in "Parent".`);
    if (type === "variable" && !sku) return errors.push(`Row ${line}: "${name}" is variable, so it needs a SKU for its variations to point at.`);
    if (type !== "variable" && regular && !/^\d+(\.\d+)?$/.test(regular)) return errors.push(`Row ${line}: price "${regular}" isn't a number.`);
    products.push({
      type, sku, name, parent_sku: parent || undefined,
      regular_price: regular, sale_price: get(r, idx.sale).replace(",", "."),
      categories: splitList(get(r, idx.cats)).join(" | "),
      images: splitList(get(r, idx.images)).filter((u) => /^https?:\/\//.test(u)),
      description: get(r, idx.desc), short_description: get(r, idx.short), stock: get(r, idx.stock),
      attributes: attrCols.map((a) => ({ name: get(r, a.name), values: splitList(get(r, a.values)) })).filter((a) => a.name && a.values.length),
    });
  });
  const main = products.filter((p) => p.type !== "variation");
  const max = demoCap(MAX_PRODUCTS, DEMO_PRODUCTS);
  if (main.length > max) errors.unshift(`${main.length} products: the limit is ${max} per store${max === DEMO_PRODUCTS && max < MAX_PRODUCTS ? " in the demo" : " for now"}.`);
  // Variables first, then their variations, so every parent exists before its children are saved.
  const order = { variable: 0, simple: 1, variation: 2 } as const;
  products.sort((a, b) => order[a.type] - order[b.type]);
  return { products, errors };
}

export const catalogPath = (c: WpConversion) => join(convDir(c.id), "catalog.json");

export function saveCatalog(c: WpConversion, fileName: string, csv: string) {
  const { products, errors } = readCatalog(csv);
  const main = products.filter((p) => p.type !== "variation");
  if (!errors.some((e) => e.includes("the limit is")) && products.length) {
    writeFileSync(catalogPath(c), JSON.stringify(products));
    c.store = c.store ?? defaultStore();
    c.store.catalog = { file: fileName.slice(0, 120), products: main.length, variations: products.length - main.length, uploadedAt: new Date().toISOString() };
    saveConversion(c);
  }
  return { products: main.length, variations: products.length - main.length, errors: errors.slice(0, 50), saved: Boolean(c.store?.catalog && products.length) };
}

/* ---------- the setup + import job ---------- */

const running = new Set<string>();
export const storeBusy = (id: string) => running.has(id);

function authFor(c: WpConversion): WpAuth {
  return { siteUrl: c.siteUrl, user: c.wpUser, appPassword: getSecrets(c.id).secret };
}

function patchRun(id: string, fn: (run: NonNullable<WpStore["run"]>, c: WpConversion) => void) {
  const c = getConversion(id);
  if (!c?.store?.run) return;
  fn(c.store.run, c);
  saveConversion(c);
}

/** Install and configure WooCommerce, then import the catalogue in batches. Runs in the background. */
export async function runStore(id: string) {
  if (running.has(id)) return;
  const c = getConversion(id);
  if (!c?.store) return;
  running.add(id);
  c.store.run = { status: "running", step: "Connecting to the site…", steps: [], notes: [], imported: 0, total: 0, errors: [], startedAt: new Date().toISOString() };
  saveConversion(c);
  const a = authFor(c);
  try {
    const p = await ping(a);
    if (!p.woo) {
      patchRun(id, (r) => { r.status = "paused"; r.step = ""; r.error = "The Studio Connector on this site is too old for stores. Download the plugin again from this page and upload it under Plugins → Add New → Upload."; });
      return;
    }
    const s = c.store;
    const secrets = readSecrets(id);
    const payments: Record<string, unknown> = {};
    for (const key of s.payments) {
      if (key === "stripe") payments.stripe = { test: s.stripe.test, publishable: s.stripe.publishable, secret: secrets.stripeSecret ?? "" };
      else if (key === "mollie") payments.mollie = { test: s.mollie.test, key: secrets.mollieKey ?? "" };
      else if (key === "bacs") payments.bacs = { accounts: s.bank };
      else payments[key] = {};
    }
    const body = {
      store: { country: s.country, address: s.address, city: s.city, postcode: s.postcode, currency: s.currency, email: s.email },
      payments,
      shipping: s.shipping,
    };
    patchRun(id, (r) => (r.step = "Installing and setting up WooCommerce…"));
    let setup = await wooSetup(a, body);
    // WooCommerce loads on the request after it's activated, so a fresh install needs a second pass.
    if (setup.retry) {
      const second = await wooSetup(a, body);
      setup = { ...second, steps: [...setup.steps.slice(0, 1), ...second.steps.slice(1)] };
    }
    patchRun(id, (r) => { r.steps = setup.steps; r.notes = setup.notes; });

    const catalog: Parameters<typeof wooProducts>[1] = existsSync(catalogPath(c)) ? JSON.parse(readFileSync(catalogPath(c), "utf8")) : [];
    patchRun(id, (r) => { r.total = catalog.length; r.step = catalog.length ? "Importing products…" : ""; });
    for (let i = 0; i < catalog.length; i += BATCH) {
      const res = await wooProducts(a, catalog.slice(i, i + BATCH));
      patchRun(id, (r) => {
        r.imported += res.saved.length;
        r.errors.push(...res.errors);
        r.step = `Importing products… ${Math.min(i + BATCH, catalog.length)}/${catalog.length}`;
      });
    }
    const live = await wooStatus(a);
    patchRun(id, (r, conv) => {
      r.status = "done";
      r.step = "";
      r.finishedAt = new Date().toISOString();
      conv.store!.live = live;
    });
    addEvent({ leadId: null, kind: "ready", title: "WooCommerce store set up", detail: `${c.business}: ${live.products} products, ${live.gateways.length} payment methods, ${live.zones.length} shipping zones` });
  } catch (e) {
    const msg = (e as Error).message.slice(0, 400);
    patchRun(id, (r) => { r.status = e instanceof WpError && (e.status === 401 || e.status === 403 || e.status === 404) ? "paused" : "failed"; r.step = ""; r.error = msg; r.finishedAt = new Date().toISOString(); });
    addEvent({ leadId: null, kind: "failed", title: "Store setup stopped", detail: `${c.business}: ${msg.slice(0, 120)}` });
  } finally {
    running.delete(id);
  }
}

/** A server restart mid-run leaves "running" behind; mark it so the user can start it again. */
export function resetStaleStoreRuns(list: WpConversion[]) {
  for (const c of list) {
    if (c.store?.run?.status === "running") {
      c.store.run.status = "failed";
      c.store.run.step = "";
      c.store.run.error = "Interrupted when the app closed. Run it again: finished steps and imported products are updated, not duplicated.";
      saveConversion(c);
    }
  }
}
