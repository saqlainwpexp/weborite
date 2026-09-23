import { connect } from "node:tls";
import type { CareHealth } from "../../shared/types.ts";
import { readCare, writeCare } from "./store.ts";

/** SSL certificate expiry straight from the TLS handshake. */
export function sslInfo(host: string): Promise<CareHealth["ssl"]> {
  return new Promise((resolve) => {
    const socket = connect({ host, port: 443, servername: host, timeout: 15000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert?.valid_to) return resolve(null);
      const validTo = new Date(cert.valid_to);
      const issuer = (Array.isArray(cert.issuer?.O) ? cert.issuer.O[0] : cert.issuer?.O) || (Array.isArray(cert.issuer?.CN) ? cert.issuer.CN[0] : cert.issuer?.CN) || "";
      resolve({ validTo: validTo.toISOString(), daysLeft: Math.floor((validTo.getTime() - Date.now()) / 86400000), issuer });
    });
    socket.on("error", () => resolve(null));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(null);
    });
  });
}

const TWO_PART = /\.(co|com|org|net|ac|gov|edu|ltd|plc|me|nom|sch)\.[a-z]{2}$/i;

/** The registrable domain (example.co.uk from www.shop.example.co.uk). */
export function registrable(host: string) {
  const parts = host.replace(/^www\./, "").split(".");
  return parts.slice(TWO_PART.test(host) ? -3 : -2).join(".");
}

/** IANA's list of each TLD's RDAP server (the registries themselves, no middleman). */
let bootstrap: { at: number; services: [string[], string[]][] } | null = null;
async function rdapBase(tld: string) {
  if (!bootstrap || Date.now() - bootstrap.at > 7 * 86400000) {
    const r = await fetch("https://data.iana.org/rdap/dns.json", { signal: AbortSignal.timeout(20000) });
    bootstrap = { at: Date.now(), services: ((await r.json()) as { services: [string[], string[]][] }).services };
  }
  return bootstrap.services.find(([tlds]) => tlds.includes(tld))?.[1][0] ?? null;
}

/** Domain expiry over RDAP (the free, structured replacement for WHOIS). */
export async function domainInfo(host: string): Promise<CareHealth["domain"]> {
  try {
    const name = registrable(host);
    const base = await rdapBase(name.split(".").pop()!);
    if (!base) return null;
    const r = await fetch(`${base.replace(/\/$/, "")}/domain/${name}`, { signal: AbortSignal.timeout(20000), redirect: "follow", headers: { Accept: "application/rdap+json", "User-Agent": "MockupStudio/1.0 (maintenance)" } });
    if (!r.ok) return null;
    const d = (await r.json()) as { events?: { eventAction: string; eventDate: string }[]; entities?: { roles?: string[]; vcardArray?: [string, [string, unknown, string, string][]] }[] };
    const exp = d.events?.find((e) => e.eventAction === "expiration")?.eventDate;
    if (!exp) return null;
    const registrar = d.entities?.find((e) => e.roles?.includes("registrar"))?.vcardArray?.[1]?.find((v) => v[0] === "fn")?.[3] ?? "";
    return { expires: new Date(exp).toISOString(), daysLeft: Math.floor((new Date(exp).getTime() - Date.now()) / 86400000), registrar: String(registrar) };
  } catch {
    return null;
  }
}

/** Open directory listings leak file names (backups, logs). */
export async function dirListing(siteUrl: string) {
  try {
    const r = await fetch(new URL("/wp-content/uploads/", siteUrl), { signal: AbortSignal.timeout(15000) });
    return /<title>Index of \//i.test(await r.text());
  } catch {
    return false;
  }
}

/* ---------- uptime: one check every 10 minutes while the app runs ---------- */

type Sample = [number, number, number]; // [unix seconds, http status (0 = unreachable), ms]

export async function pingSite(siteId: string, siteUrl: string) {
  const t = Date.now();
  let status = 0;
  try {
    const r = await fetch(siteUrl, { redirect: "follow", signal: AbortSignal.timeout(30000), headers: { "User-Agent": "MockupStudio-Uptime/1.0" } });
    status = r.status;
    await r.arrayBuffer();
  } catch {
    status = 0;
  }
  const samples = (readCare<Sample[]>(siteId, "uptime") ?? []).filter((s) => s[0] > Date.now() / 1000 - 31 * 86400);
  samples.push([Math.round(t / 1000), status, Date.now() - t]);
  writeCare(siteId, "uptime", samples);
  return status;
}

export function uptimeSummary(siteId: string): CareHealth["uptime"] {
  const samples = (readCare<Sample[]>(siteId, "uptime") ?? []).filter((s) => s[0] > Date.now() / 1000 - 30 * 86400);
  if (!samples.length) return { days30: null, checks: 0, lastDown: null, avgMs: null };
  const up = samples.filter((s) => s[1] > 0 && s[1] < 500);
  const down = samples.filter((s) => !(s[1] > 0 && s[1] < 500));
  return {
    days30: Math.round((up.length / samples.length) * 10000) / 100,
    checks: samples.length,
    lastDown: down.length ? new Date(down[down.length - 1][0] * 1000).toISOString() : null,
    avgMs: up.length ? Math.round(up.reduce((a, s) => a + s[2], 0) / up.length) : null,
  };
}

export async function gatherHealth(siteId: string, siteUrl: string): Promise<CareHealth> {
  const host = new URL(siteUrl).hostname;
  const [ssl, domain, listing] = await Promise.all([sslInfo(host), domainInfo(host), dirListing(siteUrl)]);
  return { at: new Date().toISOString(), ssl, domain, dirListing: listing, uptime: uptimeSummary(siteId) };
}
