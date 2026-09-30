import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

import type { GoLiveWpStatus, WooStatus } from "../../shared/types.ts";

export interface WpAuth {
  siteUrl: string;
  user: string;
  appPassword: string;
}

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".mp4": "video/mp4", ".webm": "video/webm", ".avif": "image/avif",
};

export class WpError extends Error {
  constructor(message: string, public status = 0) {
    super(message);
  }
}

async function call<T>(auth: WpAuth, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const url = `${auth.siteUrl.replace(/\/$/, "")}/wp-json${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: "Basic " + Buffer.from(`${auth.user}:${auth.appPassword.replace(/\s+/g, "")}`).toString("base64"),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(init.timeoutMs ?? 90000),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const msg = (body as { message?: string })?.message ?? text.slice(0, 200);
    if (res.status === 404 && path.startsWith("/studio/")) throw new WpError("The Studio Connector plugin isn't active on this site. Install the plugin zip from the dashboard.", 404);
    if (res.status === 401 || res.status === 403) throw new WpError(`WordPress refused the login (${res.status}). Check the username and Application Password. ${msg}`, res.status);
    throw new WpError(`WordPress ${res.status}: ${msg}`, res.status);
  }
  return body as T;
}

export function ping(auth: WpAuth) {
  return call<{ plugin: string; elementor: string; pro: boolean; widgets: string[]; seo?: boolean; seo_plugin?: string; care?: number; woo?: number; golive?: number; woocommerce?: string }>(auth, "/studio/v1/ping");
}

export function seoResolve(auth: WpAuth, url: string) {
  return call<{ post_id: number; attachment_id: number; seo_plugin: string }>(auth, `/studio/v1/seo/resolve?url=${encodeURIComponent(url)}`);
}

const post = <T>(auth: WpAuth, path: string, body: unknown) =>
  call<T>(auth, path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const seoMeta = (auth: WpAuth, body: { post_id: number; title: string; description: string }) => post<{ ok: boolean; written_to: string }>(auth, "/studio/v1/seo/meta", body);
export const seoSchema = (auth: WpAuth, body: { post_id: number; jsonld: unknown }) => post<{ ok: boolean }>(auth, "/studio/v1/seo/schema", body);
export const seoAlt = (auth: WpAuth, body: { attachment_id: number; alt: string }) => post<{ ok: boolean }>(auth, "/studio/v1/seo/alt", body);
export const seoWebp = (auth: WpAuth, body: { attachment_id: number; quality?: number }) =>
  post<{ ok: boolean; before: number; after: number; url?: string; skipped?: string }>(auth, "/studio/v1/seo/webp", body);

export async function uploadMedia(auth: WpAuth, file: string) {
  const name = basename(file);
  const res = await call<{ id: number; source_url: string }>(auth, "/wp/v2/media", {
    method: "POST",
    headers: { "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "Content-Disposition": `attachment; filename="${name}"` },
    body: readFileSync(file),
  });
  return { id: res.id, url: res.source_url };
}

export function upsertPage(auth: WpAuth, body: { page_id?: number | null; title: string; slug: string; elementor_data: unknown[]; template?: string; kind?: "page" | "header" | "footer" }) {
  return call<{ id: number; link: string; preview: string; edit: string }>(auth, "/studio/v1/page", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/* ---------- WooCommerce (woo.php) ---------- */

const wooPost = <T>(auth: WpAuth, path: string, body: unknown) =>
  call<T>(auth, path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), timeoutMs: 600000 });
export const wooStatus = (auth: WpAuth) => call<WooStatus>(auth, "/studio/v1/woo/status");
export const wooSetup = (auth: WpAuth, body: unknown) =>
  wooPost<{ steps: { label: string; ok: boolean; detail: string }[]; notes: string[]; retry?: boolean; status?: WooStatus }>(auth, "/studio/v1/woo/setup", body);
export const wooProducts = (auth: WpAuth, products: unknown[]) =>
  wooPost<{ saved: { sku: string; id: number; type: string }[]; errors: { sku: string; name: string; error: string }[] }>(auth, "/studio/v1/woo/products", { products });

/* ---------- Go-live kit (golive.php) ---------- */

export const goliveStatus = (auth: WpAuth) => call<GoLiveWpStatus>(auth, "/studio/v1/golive/status");
export const goliveKit = (auth: WpAuth, body: { steps: string[]; admin_email?: string; user_email?: boolean; form_recipient?: string }) =>
  wooPost<{ steps: { id: string; ok: boolean; note: string }[]; status: GoLiveWpStatus }>(auth, "/studio/v1/golive/kit", body);
export const goliveSmtp = (auth: WpAuth, body: { sender_name: string; sender_email: string; host: string; port: number; encryption: string; username: string; password: string }) =>
  wooPost<{ ok: boolean; from: string; own_domain: boolean; status: GoLiveWpStatus }>(auth, "/studio/v1/golive/smtp", body);
export const goliveMailtest = (auth: WpAuth, body: { to: string; token: string }) => post<{ sent: boolean; error: string; mailer: string }>(auth, "/studio/v1/golive/mailtest", body);
export const goliveRedirects = (auth: WpAuth, map: { from: string; to: string }[]) =>
  call<{ ok: boolean; count: number }>(auth, "/studio/v1/golive/redirects", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ map }) });
export const goliveLive = (auth: WpAuth, body: { index: boolean; remove_auth: boolean }) =>
  post<{ indexing: boolean; auth_removed: boolean; backup: string; status: GoLiveWpStatus }>(auth, "/studio/v1/golive/live", body);
