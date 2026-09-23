import type { CareIntegrity, CareStagingInfo, CareStatus } from "../../shared/types.ts";
import { WpError, type WpAuth } from "../wp/client.ts";

/**
 * Calls the connector's /care endpoints on live or on the staging copy. Uses ?rest_route= rather than
 * /wp-json/ so it works on a staging folder even where pretty permalinks don't (nginx without rules).
 */
async function call<T>(auth: WpAuth, route: string, init: { method?: "GET" | "POST"; body?: unknown; query?: Record<string, string | number>; timeoutMs?: number; stagingToken?: string } = {}): Promise<T> {
  const url = new URL(auth.siteUrl.replace(/\/$/, "") + "/");
  url.searchParams.set("rest_route", route);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = {
    Authorization: "Basic " + Buffer.from(`${auth.user}:${auth.appPassword.replace(/\s+/g, "")}`).toString("base64"),
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.stagingToken) headers.Cookie = `studio_stg=${init.stagingToken}`;
  let res: Response;
  try {
    res = await fetch(url, { method: init.method ?? "GET", headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined, signal: AbortSignal.timeout(init.timeoutMs ?? 120000) });
  } catch (e) {
    throw new WpError(`Couldn't reach ${url.host}: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text.slice(text.indexOf("{") >= 0 ? text.indexOf("{") : 0));
  } catch {
    /* not JSON */
  }
  if (!res.ok || body === null) {
    const msg = (body as { message?: string } | null)?.message ?? text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    if (res.status === 404 && /rest_no_route/.test(text)) throw new WpError("This site's Studio Connector is too old for maintenance. Download the plugin from the site's page and update it.", 404);
    if (res.status === 401 || res.status === 403) throw new WpError(`WordPress refused the login (${res.status}). The Application Password needs an administrator account. ${msg}`, res.status);
    throw new WpError(`WordPress ${res.status}: ${msg || "empty response"}`, res.status);
  }
  return body as T;
}

export type UpdateResult = { ok: boolean; from: string; to: string; messages: string[]; errors: string[] };

export const careStatus = (auth: WpAuth, refresh = false, stagingToken?: string) =>
  call<CareStatus>(auth, "/studio/v1/care/status", { query: refresh ? { refresh: 1 } : {}, timeoutMs: 180000, stagingToken });
export const careErrors = (auth: WpAuth, since: number, stagingToken?: string) =>
  call<{ counts: { fatal: number; warning: number }; fatal: string[]; files: number }>(auth, "/studio/v1/care/errors", { query: { since }, stagingToken });
export const careIntegrity = (auth: WpAuth) => call<Omit<CareIntegrity, "at">>(auth, "/studio/v1/care/integrity", { timeoutMs: 300000 });
export const careUpdate = (auth: WpAuth, type: string, id: string, stagingToken?: string) =>
  call<UpdateResult>(auth, "/studio/v1/care/update", { method: "POST", body: { type, id }, timeoutMs: 600000, stagingToken });
export const careDbUpgrade = (auth: WpAuth, stagingToken?: string) => call<{ ok: boolean; from: number; to: number }>(auth, "/studio/v1/care/db-upgrade", { method: "POST", body: {}, stagingToken });
export const careRollback = (auth: WpAuth, type: string, id: string, stagingToken?: string) =>
  call<{ ok: boolean; version: string }>(auth, "/studio/v1/care/rollback", { method: "POST", body: { type, id }, timeoutMs: 300000, stagingToken });
export const careBackup = (auth: WpAuth, action: "start" | "status") =>
  call<{ started: number; done?: boolean; success?: boolean; time?: number; errors?: string[]; queued?: boolean }>(auth, "/studio/v1/care/backup", { method: "POST", body: { action } });
export const careStaging = (auth: WpAuth, action: "start" | "continue" | "status" | "delete") =>
  call<CareStagingInfo>(auth, "/studio/v1/care/staging", { method: "POST", body: { action }, timeoutMs: 330000 });
export const careMail = (auth: WpAuth, since: number, stagingToken: string) =>
  call<{ mail: { at: number; to: string; subject: string; body: string }[]; blocked: { at: number; method: string; host: string }[] }>(auth, "/studio/v1/care/mail", { query: { since }, stagingToken });
export const careTidy = (auth: WpAuth) => call<{ transients: number; comments: number; auto_drafts: number; revisions: number }>(auth, "/studio/v1/care/tidy", { method: "POST", body: {}, timeoutMs: 300000 });
