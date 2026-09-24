import { Router } from "express";
import { hostname } from "node:os";
import { Buffer } from "node:buffer";
import { sqlite as db } from "../db.ts";
import { open, seal } from "../vault.ts";
import { localOnly } from "../security.ts";

/**
 * License-key activation for a subscription product. The desktop app activates the customer's key
 * (binding it to this machine), then re-validates periodically so a cancelled/expired subscription
 * locks the app. We call the provider's public license API (LemonSqueezy shape by default) with only
 * the key — no secret is embedded. An offline grace window keeps paying users working through a
 * network blip. In development the gate is bypassed.
 *
 * Provider setup (yours): sell a subscription product with license keys enabled (LemonSqueezy /
 * Keygen). Nothing here needs your store ID or API secret — the customer's key is enough.
 */

const API = process.env.STUDIO_LICENSE_API ?? "https://api.lemonsqueezy.com/v1";
const GRACE_DAYS = Number(process.env.STUDIO_LICENSE_GRACE_DAYS ?? 7);
// Bypass while developing (Electron sets this in dev; the plain `npm run dev` API has no STUDIO_DESKTOP).
const BYPASS = process.env.STUDIO_LICENSE_BYPASS === "1" || process.env.STUDIO_DESKTOP !== "1";

db.exec(`CREATE TABLE IF NOT EXISTS license (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);`);

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

/** Call the provider's license API. Returns parsed JSON or throws a friendly, offline-aware error. */
async function providerCall(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
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
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
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

function publicState() {
  const s = read();
  return {
    bypass: BYPASS,
    activated: Boolean(s?.instanceId),
    licensed: isLicensed(),
    status: BYPASS ? "developer" : s?.status ?? "none",
    name: s?.name ?? "",
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
  const status = (lk?.status as LicenseState["status"]) ?? (valid ? "active" : "inactive");
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

license.post("/deactivate", async (_req, res) => {
  await deactivate();
  res.json(publicState());
});

/** Middleware: block the API for unlicensed installs (except the license + basic read routes). */
export function requireLicense(allow: RegExp) {
  return (req: Parameters<typeof localOnly>[0], res: Parameters<typeof localOnly>[1], next: Parameters<typeof localOnly>[2]) => {
    if (isLicensed() || allow.test(req.path)) return next();
    res.status(402).json({ error: "This copy isn't activated.", needsLicense: true });
  };
}
