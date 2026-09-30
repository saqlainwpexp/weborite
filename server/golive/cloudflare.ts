import type { DnsRecordLite } from "../../shared/types.ts";

const API = process.env.STUDIO_CF_API ?? "https://api.cloudflare.com/client/v4";

export class CfError extends Error {}

async function cf<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  if (!token) throw new CfError("Add a Cloudflare API token under Settings → Integrations first (permissions: Zone → Zone → Read and Zone → DNS → Edit).");
  const r = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let j: { success?: boolean; errors?: { message: string }[]; result?: T; result_info?: { total_pages?: number } } = {};
  try {
    j = JSON.parse(text);
  } catch {
    if (!r.ok) throw new CfError(`Cloudflare ${r.status}: ${text.slice(0, 160)}`);
    return text as unknown as T;
  }
  if (!r.ok || j.success === false) throw new CfError(`Cloudflare: ${j.errors?.map((e) => e.message).join("; ") || r.status}`);
  return (j.result ?? j) as T;
}

type CfRecord = DnsRecordLite & { id: string; zone_name?: string; comment?: string | null };

export async function verifyToken(token: string) {
  return cf<{ status: string }>(token, "/user/tokens/verify");
}

export async function findZone(token: string, domain: string) {
  const zones = await cf<{ id: string; name: string; status: string; name_servers: string[] }[]>(token, `/zones?name=${encodeURIComponent(domain)}`);
  if (!zones.length) throw new CfError(`${domain} isn't in this Cloudflare account. Add the site in Cloudflare first (see the transfer plan), or use a token for the account that has it.`);
  return zones[0];
}

export async function listRecords(token: string, zoneId: string): Promise<CfRecord[]> {
  const out: CfRecord[] = [];
  for (let page = 1; page < 50; page++) {
    const batch = await cf<CfRecord[]>(token, `/zones/${zoneId}/dns_records?per_page=500&page=${page}`);
    out.push(...batch);
    if (batch.length < 500) break;
  }
  return out;
}

export async function exportBind(token: string, zoneId: string) {
  return cf<string>(token, `/zones/${zoneId}/dns_records/export`).catch(() => "");
}

export const patchRecord = (token: string, zoneId: string, id: string, body: Partial<DnsRecordLite>) =>
  cf<CfRecord>(token, `/zones/${zoneId}/dns_records/${id}`, { method: "PATCH", body: JSON.stringify(body) });
export const createRecord = (token: string, zoneId: string, body: DnsRecordLite & { comment?: string }) =>
  cf<CfRecord>(token, `/zones/${zoneId}/dns_records`, { method: "POST", body: JSON.stringify({ ttl: 1, ...body }) });
export const deleteRecord = (token: string, zoneId: string, id: string) =>
  cf<{ id: string }>(token, `/zones/${zoneId}/dns_records/${id}`, { method: "DELETE" });

/** Hostnames that carry mail: these must never be proxied (Cloudflare only proxies HTTP). */
const MAIL_LABELS = ["mail", "smtp", "imap", "pop", "pop3", "webmail", "autodiscover", "autoconfig", "cpanel", "whm", "ftp", "mx", "email", "exchange", "owa"];

export function mailHostnames(zone: string, records: CfRecord[]) {
  const names = new Set(MAIL_LABELS.map((l) => `${l}.${zone}`));
  for (const r of records) if (r.type === "MX") names.add(r.content.toLowerCase().replace(/\.$/, ""));
  return names;
}

export function proxiedMailRecords(zone: string, records: CfRecord[]) {
  const names = mailHostnames(zone, records);
  return records.filter((r) => r.proxied && ["A", "AAAA", "CNAME"].includes(r.type) && names.has(r.name.toLowerCase()));
}

export type Step = { text: string; ok: boolean };

/** Point mail hostnames at the server directly (grey cloud). */
export async function fixMail(token: string, zoneId: string, zone: string): Promise<Step[]> {
  const steps: Step[] = [];
  for (const r of proxiedMailRecords(zone, await listRecords(token, zoneId))) {
    try {
      await patchRecord(token, zoneId, r.id, { proxied: false });
      steps.push({ ok: true, text: `${r.type} ${r.name} switched to DNS only` });
    } catch (e) {
      steps.push({ ok: false, text: `${r.name}: ${(e as Error).message}` });
    }
  }
  if (!steps.length) steps.push({ ok: true, text: "No mail hostname is proxied" });
  return steps;
}

/** old.<domain> → wherever the site lives now, so the old site stays reachable for reference after cutover. */
export async function createOld(token: string, zoneId: string, zone: string, snapshot: DnsRecordLite[]): Promise<Step[]> {
  const records = await listRecords(token, zoneId);
  const name = `old.${zone}`;
  if (records.some((r) => r.name === name)) return [{ ok: true, text: `${name} already exists` }];
  const root = snapshot.filter((r) => r.name === zone && ["A", "AAAA", "CNAME"].includes(r.type));
  if (!root.length) return [{ ok: false, text: `The snapshot has no A, AAAA or CNAME record for ${zone}` }];
  const steps: Step[] = [];
  for (const r of root) {
    await createRecord(token, zoneId, { type: r.type, name, content: r.content, proxied: false, comment: "Weborite Studio: old site, kept for reference after go-live" });
    steps.push({ ok: true, text: `${r.type} ${name} → ${r.content} (DNS only)` });
  }
  steps.push({ ok: true, text: `The old host must also answer for ${name}: add it as an alias or parked domain there, or it may show the host's default page.` });
  return steps;
}

/** Cutover: only the site's A records at the root and www change. Mail, TXT and everything else stay as they are. */
export async function cutover(token: string, zoneId: string, zone: string, newIp: string): Promise<Step[]> {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(newIp)) throw new CfError("Enter the new host's IPv4 address");
  const records = await listRecords(token, zoneId);
  const steps: Step[] = [];
  for (const name of [zone, `www.${zone}`]) {
    const here = records.filter((r) => r.name === name);
    const a = here.filter((r) => r.type === "A");
    const cname = here.find((r) => r.type === "CNAME");
    if (name !== zone && cname) {
      steps.push({ ok: true, text: `${name} is a CNAME to ${cname.content}: ${cname.content === zone ? "it follows the root" : "left alone, check it points at the new host"}` });
      continue;
    }
    if (!a.length) {
      await createRecord(token, zoneId, { type: "A", name, content: newIp, proxied: true });
      steps.push({ ok: true, text: `A ${name} → ${newIp} created` });
    } else {
      await patchRecord(token, zoneId, a[0].id, { content: newIp });
      steps.push({ ok: true, text: `A ${name}: ${a[0].content} → ${newIp}` });
      for (const extra of a.slice(1)) {
        await deleteRecord(token, zoneId, extra.id);
        steps.push({ ok: true, text: `A ${name} → ${extra.content} removed (the old host's second address)` });
      }
    }
    for (const six of here.filter((r) => r.type === "AAAA")) {
      await deleteRecord(token, zoneId, six.id);
      steps.push({ ok: true, text: `AAAA ${name} → ${six.content} removed: it pointed at the old host, and IPv6 visitors would still land there` });
    }
  }
  return steps;
}

/** Put the root and www back exactly as the snapshot had them. */
export async function rollback(token: string, zoneId: string, zone: string, snapshot: DnsRecordLite[]): Promise<Step[]> {
  const records = await listRecords(token, zoneId);
  const steps: Step[] = [];
  const types = ["A", "AAAA", "CNAME"];
  for (const name of [zone, `www.${zone}`]) {
    const want = snapshot.filter((r) => r.name === name && types.includes(r.type));
    const have = records.filter((r) => r.name === name && types.includes(r.type));
    for (const h of have) {
      if (!want.some((w) => w.type === h.type && w.content === h.content)) {
        await deleteRecord(token, zoneId, h.id);
        steps.push({ ok: true, text: `${h.type} ${name} → ${h.content} removed` });
      }
    }
    for (const w of want) {
      const match = have.find((h) => h.type === w.type && h.content === w.content);
      if (match) {
        if (Boolean(match.proxied) !== Boolean(w.proxied)) await patchRecord(token, zoneId, match.id, { proxied: w.proxied });
        continue;
      }
      await createRecord(token, zoneId, { type: w.type, name, content: w.content, proxied: w.proxied, ttl: w.ttl });
      steps.push({ ok: true, text: `${w.type} ${name} → ${w.content} restored` });
    }
  }
  if (!steps.length) steps.push({ ok: true, text: "Root and www already match the snapshot" });
  return steps;
}

export const lite = (r: CfRecord): DnsRecordLite => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied, ttl: r.ttl, priority: r.priority });
