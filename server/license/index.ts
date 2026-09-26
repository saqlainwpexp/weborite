import { Router } from "express";
import { hostname } from "node:os";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { Buffer } from "node:buffer";
import { getSettings, setSettings, sqlite as db } from "../db.ts";
import { TERMS_VERSION } from "../../shared/legal.ts";
import { LICENSE_API, LICENSE_PUBLIC_KEY } from "../../shared/licenseKey.ts";
import { DEMO_CREATE_ROUTES, DEMO_LABELS, DEMO_LIMITS, DEMO_PRODUCTS, DEMO_RESULTS, type DemoKind, type DemoState } from "../../shared/demo.ts";
import { open, seal } from "../vault.ts";
import { localOnly } from "../security.ts";

/**
 * License-key activation for a subscription product. The desktop app activates the customer's key
 * (binding it to this machine), then re-validates periodically so a cancelled/expired subscription
 * locks the app. It calls our own license service (site/license/, Lemon Squeezy's API shape) with only
 * the key, and trusts an answer only when it carries a valid Ed25519 signature over the nonce it sent.
 * An offline grace window keeps paying users working through a network blip. In development the gate
 * is bypassed.
 */

/**
 * "customer" / "owner" when bundled for the desktop app (scripts/build-server.mjs); "source" when run from the
 * TypeScript (npm run dev). A shipped customer build ignores every licensing environment variable.
 */
declare const __STUDIO_BUILD__: string | undefined;
const BUILD = typeof __STUDIO_BUILD__ === "string" ? __STUDIO_BUILD__ : "source";
const SHIPPED = BUILD === "customer";
const API = (!SHIPPED && process.env.STUDIO_LICENSE_API) || LICENSE_API;
// From source, a test server can bring its own key; with none at all, answers aren't checked (source only).
const PUBLIC_KEY = (!SHIPPED && process.env.STUDIO_LICENSE_PUBKEY) || LICENSE_PUBLIC_KEY;
const verifier = PUBLIC_KEY
  ? createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(PUBLIC_KEY, "base64")]), format: "der", type: "spki" })
  : null;
const GRACE_DAYS = SHIPPED ? 7 : Number(process.env.STUDIO_LICENSE_GRACE_DAYS ?? 7);
// Skipped for the owner build and plain `npm run dev`; a customer build never skips it. From source,
// STUDIO_DESKTOP=1 (without STUDIO_LICENSE_BYPASS) runs the real check, e.g. to test the onboarding.
const BYPASS = BUILD === "owner" || (BUILD === "source" && (process.env.STUDIO_LICENSE_BYPASS === "1" || process.env.STUDIO_DESKTOP !== "1"));

db.exec(`CREATE TABLE IF NOT EXISTS license (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);`);
db.exec(`CREATE TABLE IF NOT EXISTS onboarding (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);`);

/** Who set up this copy, and when they accepted which version of the terms and privacy policy. */
interface Onboarding {
  firstName: string;
  lastName: string;
  email: string;
  company: string;
  phone: string;
  country: string;
  marketing: boolean; // opted in to product news (never pre-ticked)
  demo?: boolean; // chose "Try the demo" instead of entering a key
  termsVersion: string;
  acceptedAt: string;
}
db.exec(`CREATE TABLE IF NOT EXISTS demo_usage (kind TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0);`);
const demoUsed = (kind: DemoKind) =>
  (db.prepare("SELECT used FROM demo_usage WHERE kind = ?").get(kind) as { used: number } | undefined)?.used ?? 0;
const bumpDemo = (kind: DemoKind) =>
  db.prepare("INSERT INTO demo_usage (kind, used) VALUES (?, 1) ON CONFLICT(kind) DO UPDATE SET used = used + 1").run(kind);

function readOnboarding(): Onboarding | null {
  const r = db.prepare("SELECT data FROM onboarding WHERE id = 1").get() as { data: string } | undefined;
  return r ? (JSON.parse(r.data) as Onboarding) : null;
}

interface LicenseState {
  key: string; // sealed
  instanceId: string;
  status: "active" | "inactive" | "expired" | "disabled" | "unknown";
  lastOkAt: string | null; // last time the provider confirmed it valid
  lastCheckAt: string | null;
  name: string; // customer/product name from the provider, for display
}

function read(): LicenseState | null {
  const r = db.prepare("SELECT data FROM license WHERE id = 1").get() as { data: string } | undefined;
  return r ? (JSON.parse(r.data) as LicenseState) : null;
}
function write(s: LicenseState) {
  db.prepare("INSERT INTO license (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(s));
}
function clear() {
  db.prepare("DELETE FROM license WHERE id = 1").run();
}

/** Call the license API. Returns parsed JSON or throws a friendly, offline-aware error. The fields the app acts on
 *  (activated / valid, status, instance id) are taken only from the signed part of the answer. */
async function providerCall(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const nonce = randomUUID();
  params = { ...params, nonce };
  let res: Response;
  try {
    res = await fetch(`${API}/licenses/${path}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    const e = new Error("offline") as Error & { offline?: boolean };
    e.offline = true;
    throw e;
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!verifier && !SHIPPED) return data;
  const signed = typeof data.signed === "string" ? Buffer.from(data.signed, "base64") : null;
  const sig = typeof data.signature === "string" ? Buffer.from(data.signature, "base64") : null;
  let core: { action?: string; ok?: boolean; status?: string; instance_id?: string; nonce?: string } | null = null;
  try {
    if (verifier && signed && sig && verify(null, signed, verifier, sig)) core = JSON.parse(signed.toString("utf8"));
  } catch {
    core = null;
  }
  if (!core || core.nonce !== nonce || core.action !== path) {
    // Not our server (or tampered with): treat like being offline, so a real customer keeps their grace period.
    const e = new Error("unverified") as Error & { offline?: boolean };
    e.offline = true;
    throw e;
  }
  const lk = (data.license_key ?? {}) as Record<string, unknown>;
  const inst = (data.instance ?? null) as Record<string, unknown> | null;
  return {
    ...data,
    activated: path === "activate" && core.ok === true,
    valid: path === "validate" && core.ok === true,
    license_key: { ...lk, status: core.status },
    instance: core.instance_id ? { ...inst, id: core.instance_id } : null,
  };
}

const withinGrace = (s: LicenseState) => s.lastOkAt != null && Date.now() - new Date(s.lastOkAt).getTime() < GRACE_DAYS * 86400_000;

/** Is the app unlocked right now? */
export function isLicensed(): boolean {
  if (BYPASS) return true;
  const s = read();
  if (!s || !s.instanceId) return false;
  if (s.status === "expired" || s.status === "disabled" || s.status === "inactive") return false;
  return s.status === "active" || withinGrace(s);
}

/** Running as a demo: onboarded with "Try the demo" and no key entered since. */
export function isDemo(): boolean {
  if (isLicensed()) return false;
  const o = readOnboarding();
  return Boolean(o?.demo && o.termsVersion === TERMS_VERSION);
}

function demoState(): DemoState {
  const left = Object.fromEntries((Object.keys(DEMO_LIMITS) as DemoKind[]).map((k) => [k, Math.max(0, DEMO_LIMITS[k] - demoUsed(k))])) as Record<DemoKind, number>;
  return { left, results: DEMO_RESULTS, products: DEMO_PRODUCTS };
}

/** How many more of something this copy may create: Infinity when licensed. */
export function demoLeft(kind: DemoKind): number {
  return isDemo() ? Math.max(0, DEMO_LIMITS[kind] - demoUsed(kind)) : Infinity;
}
/** Record one use of a demo allowance (no-op when licensed). */
export function useDemoAllowance(kind: DemoKind) {
  if (isDemo()) bumpDemo(kind);
}
export class DemoLimitError extends Error {}
export const demoLimitMessage = (kind: DemoKind) =>
  `The demo includes ${DEMO_LIMITS[kind]} ${DEMO_LABELS[kind][DEMO_LIMITS[kind] === 1 ? 0 : 1]}, and ${DEMO_LIMITS[kind] === 1 ? "it's" : "they're"} used. Enter a license key to keep going.`;
/** Cap for results per search and products per store in the demo. */
export const demoCap = (n: number, cap: number) => (isDemo() ? Math.min(n, cap) : n);

function publicState() {
  const s = read();
  return {
    bypass: BYPASS,
    activated: Boolean(s?.instanceId),
    licensed: isLicensed(),
    status: BYPASS ? "developer" : s?.status ?? "none",
    name: s?.name ?? "",
    onboarded: readOnboarding()?.termsVersion === TERMS_VERSION,
    demo: isDemo() ? demoState() : null,
    lastCheckAt: s?.lastCheckAt ?? null,
    graceUntil: s?.lastOkAt ? new Date(new Date(s.lastOkAt).getTime() + GRACE_DAYS * 86400_000).toISOString() : null,
  };
}

/** Activate a key on this machine. */
async function activate(key: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, error: "Enter your license key." };
  let data: Record<string, unknown>;
  try {
    data = await providerCall("activate", { license_key: trimmed, instance_name: hostname().slice(0, 60) || "Weborite Studio" });
  } catch {
    return { ok: false, error: "Couldn't reach the licensing server. Check your internet connection and try again." };
  }
  const activated = data.activated === true;
  const instance = data.instance as { id?: string } | undefined;
  const lk = data.license_key as { status?: string } | undefined;
  const meta = data.meta as { customer_name?: string; product_name?: string } | undefined;
  if (!activated || !instance?.id) {
    return { ok: false, error: String(data.error ?? "That license key was rejected. Check it and your subscription status.") };
  }
  const now = new Date().toISOString();
  write({ key: seal(trimmed), instanceId: instance.id, status: (lk?.status as LicenseState["status"]) ?? "active", lastOkAt: now, lastCheckAt: now, name: meta?.product_name || meta?.customer_name || "" });
  return { ok: true };
}

/** Re-check the key with the provider (called on startup and on a timer). */
export async function revalidate(): Promise<void> {
  if (BYPASS) return;
  const s = read();
  if (!s?.instanceId) return;
  let data: Record<string, unknown>;
  try {
    data = await providerCall("validate", { license_key: open(s.key), instance_id: s.instanceId });
  } catch {
    // Offline: leave state; the grace window in isLicensed() decides.
    write({ ...s, lastCheckAt: new Date().toISOString() });
    return;
  }
  const valid = data.valid === true;
  const lk = data.license_key as { status?: string } | undefined;
  const now = new Date().toISOString();
  // An invalid answer never leaves the copy unlocked, whatever status came with it.
  const status: LicenseState["status"] = valid ? ((lk?.status as LicenseState["status"]) ?? "active") : lk?.status && lk.status !== "active" ? (lk.status as LicenseState["status"]) : "inactive";
  write({ ...s, status, lastCheckAt: now, lastOkAt: valid ? now : s.lastOkAt });
}

async function deactivate(): Promise<void> {
  const s = read();
  if (s?.instanceId) {
    try {
      await providerCall("deactivate", { license_key: open(s.key), instance_id: s.instanceId });
    } catch {
      /* deactivate best-effort; we still clear locally */
    }
  }
  clear();
}

let timer: NodeJS.Timeout | null = null;
export function startLicenseTimers() {
  if (timer || BYPASS) return;
  void revalidate();
  timer = setInterval(() => void revalidate(), 12 * 3600_000);
}

/* ---------- routes ---------- */

export const license = Router();

license.get("/status", (_req, res) => res.json(publicState()));

license.post("/activate", async (req, res) => {
  const r = await activate(String(req.body?.key ?? ""));
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json(publicState());
});

/**
 * First-run onboarding: activate the key (unless this copy is already licensed or in developer mode), then
 * store the owner's details and their acceptance of the current terms and privacy policy. The details also
 * fill in Settings → Profile.
 */
license.post("/onboard", async (req, res) => {
  const b = req.body ?? {};
  const str = (v: unknown, max = 120) => String(v ?? "").trim().slice(0, max);
  const data: Onboarding = {
    firstName: str(b.firstName, 60),
    lastName: str(b.lastName, 60),
    email: str(b.email, 200).toLowerCase(),
    company: str(b.company, 120),
    phone: str(b.phone, 40),
    country: str(b.country, 60),
    marketing: b.marketing === true,
    demo: b.demo === true && !isLicensed(),
    termsVersion: TERMS_VERSION,
    acceptedAt: new Date().toISOString(),
  };
  if (!data.firstName || !data.lastName) return res.status(400).json({ error: "Enter your first and last name.", field: "name" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email)) return res.status(400).json({ error: "Enter a valid email address.", field: "email" });
  if (b.acceptTerms !== true) return res.status(400).json({ error: "Accept the Terms of Service and Privacy Policy to continue.", field: "terms" });
  if (!isLicensed() && !data.demo) {
    const r = await activate(String(b.key ?? ""));
    if (!r.ok) return res.status(400).json({ error: r.error, field: "key" });
  }
  db.prepare("INSERT INTO onboarding (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(JSON.stringify(data));
  // Pre-fill the profile, without overwriting anything the user already set there.
  const cur = getSettings();
  setSettings({
    ...(!cur.firstName && { firstName: data.firstName }),
    ...(!cur.lastName && { lastName: data.lastName }),
    ...(!cur.userEmail && { userEmail: data.email }),
    ...(!cur.userPhone && data.phone && { userPhone: data.phone }),
    ...((!cur.studioName || cur.studioName === "Studio") && data.company && { studioName: data.company }),
  });
  res.json(publicState());
});

license.get("/onboarding", (_req, res) => {
  const o = readOnboarding();
  res.json(o ? { ...o, current: o.termsVersion === TERMS_VERSION } : null);
});

license.post("/deactivate", async (_req, res) => {
  await deactivate();
  res.json(publicState());
});

/** Middleware: block the API for unlicensed installs (except the license + basic read routes). */
export function requireLicense(allow: RegExp) {
  return (req: Parameters<typeof localOnly>[0], res: Parameters<typeof localOnly>[1], next: Parameters<typeof localOnly>[2]) => {
    // The dashboard itself always loads: it shows the activation screen. Only data is gated.
    if (!/^\/(api|files)\//.test(req.path)) return next();
    if (isLicensed() || allow.test(req.path)) return next();
    if (isDemo()) return demoGate(req, res, next);
    res.status(402).json({ error: "This copy isn't activated.", needsLicense: true });
  };
}

/** Demo allowances: creating something in a workspace, and the number of mockups (checked up front here,
 *  counted where leads are created so webhooks and automations count too). */
function demoGate(req: Parameters<typeof localOnly>[0], res: Parameters<typeof localOnly>[1], next: Parameters<typeof localOnly>[2]) {
  if (req.method !== "POST") return next();
  const path = req.path.replace(/\/$/, "");
  const createsLead = path === "/api/leads" || /^\/api\/finder\/prospects\/[^/]+\/mockup$/.test(path);
  if (createsLead) return demoLeft("mockups") > 0 ? next() : res.status(402).json({ error: demoLimitMessage("mockups"), demoLimit: "mockups" });
  const kind = DEMO_CREATE_ROUTES[path];
  if (!kind) return next();
  if (demoLeft(kind) <= 0) return res.status(402).json({ error: demoLimitMessage(kind), demoLimit: kind });
  if (req.body && (kind === "searches")) req.body.max = Math.min(Number(req.body.max) || DEMO_RESULTS, DEMO_RESULTS);
  res.on("finish", () => {
    if (res.statusCode < 400) bumpDemo(kind);
  });
  next();
}

/** Webhooks work for licensed copies and demos (their leads count against the demo's mockups). */
export function requireFullLicense(_req: Parameters<typeof localOnly>[0], res: Parameters<typeof localOnly>[1], next: Parameters<typeof localOnly>[2]) {
  if (isLicensed() || isDemo()) return next();
  res.status(402).json({ error: "This copy isn't activated." });
}
