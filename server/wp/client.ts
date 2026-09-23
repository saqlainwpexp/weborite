import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

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

async function call<T>(auth: WpAuth, path: string, init: RequestInit = {}): Promise<T> {
  const url = `${auth.siteUrl.replace(/\/$/, "")}/wp-json${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: "Basic " + Buffer.from(`${auth.user}:${auth.appPassword.replace(/\s+/g, "")}`).toString("base64"),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(90000),
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
  return call<{ plugin: string; elementor: string; pro: boolean; widgets: string[]; seo?: boolean; seo_plugin?: string; care?: number }>(auth, "/studio/v1/ping");
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
