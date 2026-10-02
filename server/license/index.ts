import { Router } from "express";
import { hostname } from "node:os";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { Buffer } from "node:buffer";
import { getSettings, setSettings, sqlite as db } from "../db.ts";
import { TERMS_VERSION } from "../../shared/legal.ts";
import { LICENSE_API, LICENSE_PUBLIC_KEY } from "../../shared/licenseKey.ts";
import { DEMO_AUTOMATION_LEADS, DEMO_CREATE_ROUTES, DEMO_DAYS, DEMO_LABELS, DEMO_LIMITS, DEMO_PRODUCTS, DEMO_RESULTS, type DemoKind, type DemoState } from "../../shared/demo.ts";
import { countEnrollments } from "../automations/store.ts";
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
  role: string; // "What you do"
  companyDescription: string;
  // Personalization, used to tailor mockups and outreach to this agency.
  niche: string;
  writingStyle: string; // past chat/email references that show their voice
  caseStudies: string; // previous work
  designContext: string; // previous designs, mission and goals
  personalizationNotes: string; // anything else
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
  /** Shown in Settings → Plan & license. */
  plan?: string; // monthly | yearly | trial | lifetime (from the license server)
  expiresAt?: string | null;
  customerName?: string;
  customerEmail?: string;
  keyHint?: string; // last 4 characters of the key
  activatedAt?: string;
  computer?: string;
}

type Meta = { customer_name?: string; customer_email?: string; product_name?: string; plan?: string } | undefined;
/** Plan and customer details from a license answer (display only; the signed status decides access). */
const details = (data: Record<string, unknown>) => {
  const meta = data.meta as Meta;
  const lk = data.license_key as { expires_at?: string | null } | undefined;
  return {
    ...(meta?.plan && { plan: meta.plan }),
    ...(lk && "expires_at" in lk && { expiresAt: lk.expires_at ?? null }),
    ...(meta?.customer_name && { customerName: meta.customer_name }),
    ...(meta?.customer_email && { customerEmail: meta.customer_email }),
  };
};

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
    license_key: { ...lk, status: core.status, ...("expires_at" in core && { expires_at: (core as { expires_at?: string | null }).expires_at ?? null }) },
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

/** When the free trial ends: 7 days after the person chose the demo. Null when not a demo. */
export function demoExpiry(): string | null {
  const o = readOnboarding();
  if (!o?.demo || !o.acceptedAt) return null;
  return new Date(new Date(o.acceptedAt).getTime() + DEMO_DAYS * 86400_000).toISOString();
}

/** Whole days left in the trial (0 on the final day, never negative). */
export function demoDaysLeft(): number {
  const e = demoExpiry();
  if (!e) return 0;
  return Math.max(0, Math.ceil((new Date(e).getTime() - Date.now()) / 86400_000));
}

/** The 7 days are up: the demo is over and everything is blocked until a key is entered. */
export function isDemoExpired(): boolean {
  if (!isDemo()) return false;
  const e = demoExpiry();
  return Boolean(e && Date.now() > new Date(e).getTime());
}

/** Businesses the automations may still enrol before the demo's shared cap. */
export function demoAutomationLeadsLeft(): number {
  if (!isDemo()) return Infinity;
  if (isDemoExpired()) return 0;
  return Math.max(0, DEMO_AUTOMATION_LEADS - countEnrollments());
}

function demoState(): DemoState {
  const expired = isDemoExpired();
  const left = Object.fromEntries(
    (Object.keys(DEMO_LIMITS) as DemoKind[]).map((k) => [k, expired ? 0 : Math.max(0, DEMO_LIMITS[k] - demoUsed(k))]),
  ) as Record<DemoKind, number>;
  return {
    left,
    results: DEMO_RESULTS,
    products: DEMO_PRODUCTS,
    expiresAt: demoExpiry(),
    daysLeft: demoDaysLeft(),
    expired,
    automationLeadsLeft: demoAutomationLeadsLeft() === Infinity ? DEMO_AUTOMATION_LEADS : demoAutomationLeadsLeft(),
  };
}

/** How many more of something this copy may create: Infinity when licensed, 0 once the trial ends. */
export function demoLeft(kind: DemoKind): number {
  if (!isDemo()) return Infinity;
  if (isDemoExpired()) return 0;
  return Math.max(0, DEMO_LIMITS[kind] - demoUsed(kind));
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
    license: s?.instanceId
      ? { plan: s.plan ?? "", expiresAt: s.expiresAt ?? null, customerName: s.customerName ?? "", customerEmail: s.customerEmail ?? "", keyHint: s.keyHint ?? "", activatedAt: s.activatedAt ?? null, computer: s.computer ?? "" }
      : null,
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
  write({
    key: seal(trimmed), instanceId: instance.id, status: (lk?.status as LicenseState["status"]) ?? "active", lastOkAt: now, lastCheckAt: now,
    name: meta?.product_name || meta?.customer_name || "", ...details(data), keyHint: trimmed.slice(-4), activatedAt: now, computer: hostname().slice(0, 60),
  });
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
  write({ ...s, ...details(data), status, lastCheckAt: now, lastOkAt: valid ? now : s.lastOkAt });
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
/** Email the new customer's onboarding details to Weborite (info@weborite.com), via the license site.
 *  Fire-and-forget: any failure (offline, server down) is swallowed so setup always completes. */
async function notifyOnboarding(data: Onboarding): Promise<void> {
  try {
    await fetch(`${API}/onboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: data.firstName, lastName: data.lastName, email: data.email, phone: data.phone,
        company: data.company, country: data.country, role: data.role, companyDescription: data.companyDescription,
        niche: data.niche, writingStyle: data.writingStyle, caseStudies: data.caseStudies,
        designContext: data.designContext, personalizationNotes: data.personalizationNotes,
        marketing: data.marketing, demo: Boolean(data.demo),
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    /* customer offline or mail endpoint unavailable — not fatal to onboarding */
  }
}

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
    role: str(b.role, 120),
    companyDescription: str(b.companyDescription, 1000),
    niche: str(b.niche, 500),
    writingStyle: str(b.writingStyle, 4000),
    caseStudies: str(b.caseStudies, 4000),
    designContext: str(b.designContext, 4000),
    personalizationNotes: str(b.personalizationNotes, 4000),
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
  // Pre-fill the profile, without overwriting anything the user already set there. The personalization
  // fields feed the mockup and outreach prompts (see agencyProfileBlock).
  const cur = getSettings();
  setSettings({
    ...(!cur.firstName && { firstName: data.firstName }),
    ...(!cur.lastName && { lastName: data.lastName }),
    ...(!cur.userEmail && { userEmail: data.email }),
    ...(!cur.userPhone && data.phone && { userPhone: data.phone }),
    ...((!cur.studioName || cur.studioName === "Studio") && data.company && { studioName: data.company }),
    ...(!cur.role && data.role && { role: data.role }),
    ...(!cur.companyDescription && data.companyDescription && { companyDescription: data.companyDescription }),
    ...(!cur.niche && data.niche && { niche: data.niche }),
    ...(!cur.writingStyle && data.writingStyle && { writingStyle: data.writingStyle }),
    ...(!cur.caseStudies && data.caseStudies && { caseStudies: data.caseStudies }),
    ...(!cur.designContext && data.designContext && { designContext: data.designContext }),
    ...(!cur.personalizationNotes && data.personalizationNotes && { personalizationNotes: data.personalizationNotes }),
  });
  // Send the details to Weborite (info@weborite.com) so they can welcome and support the new customer.
  // Best effort: never block or fail onboarding if the customer is offline or the mail server is down.
  void notifyOnboarding(data);
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

/** Check the key with the license server now (Settings → Plan & license → Check now). */
license.post("/refresh", async (_req, res) => {
  await revalidate();
  res.json(publicState());
});

/** Go back to the demo without a key (after moving the license to another computer, or when it lapsed). */
license.post("/demo", (_req, res) => {
  if (isLicensed()) return res.status(400).json({ error: "This copy has an active license, so there's no need for the demo." });
  const o = readOnboarding();
  if (!o || o.termsVersion !== TERMS_VERSION) return res.status(400).json({ error: "Finish setting up first." });
  db.prepare("UPDATE onboarding SET data = ? WHERE id = 1").run(JSON.stringify({ ...o, demo: true }));
  res.json(publicState());
});

/** Middleware: block the API for unlicensed installs (except the license + basic read routes). */
export function requireLicense(allow: RegExp) {
  return (req: Parameters<typeof localOnly>[0], res: Parameters<typeof localOnly>[1], next: Parameters<typeof localOnly>[2]) => {
    // The dashboard itself always loads: it shows the activation screen. Only data is gated.
    if (!/^\/(api|files)\//.test(req.path)) return next();
    if (isLicensed() || allow.test(req.path)) return next();
    if (isDemo()) {
      // The 7 days are up: block everything (reads included) until a key is entered.
      if (isDemoExpired()) return res.status(402).json({ error: `Your ${DEMO_DAYS}-day free trial has ended. Enter a license key to keep going.`, needsLicense: true, demoExpired: true });
      return demoGate(req, res, next);
    }
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
