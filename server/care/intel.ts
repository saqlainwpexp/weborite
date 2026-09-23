import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CareAbandoned, CareIntel, CareSeverity, CareStatus, CareVuln } from "../../shared/types.ts";
import { CARE_DIR } from "./store.ts";

/**
 * Known vulnerabilities come from WPVulnerability.net (free, no key; aggregates CVE, Wordfence,
 * Patchstack and WPScan data). Abandoned plugins come from the wordpress.org plugin API.
 */
const CACHE = join(CARE_DIR, "_cache");
const TTL = 12 * 3600 * 1000;

async function cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, key.replace(/[^a-z0-9._-]/gi, "_") + ".json");
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < TTL) return JSON.parse(readFileSync(file, "utf8")) as T;
  const data = await fetcher();
  writeFileSync(file, JSON.stringify(data));
  return data;
}

const getJson = async (url: string) => {
  const r = await fetch(url, { headers: { "User-Agent": "MockupStudio/1.0 (maintenance)" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  return r.json();
};

/** Compare WordPress-style versions ("6.4.1", "4.1.4-beta"). */
export function cmpVersion(a: string, b: string) {
  const pa = a.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

type Operator = { min_version: string | null; min_operator: string | null; max_version: string | null; max_operator: string | null; unfixed: string };
type RawVuln = {
  name: string;
  operator?: Operator;
  source?: { id: string; name: string; link: string }[];
  impact?: { cvss?: { score?: string; severity?: string } };
};

const test = (v: string, op: string | null, bound: string | null) => {
  if (!bound || !op) return true;
  const c = cmpVersion(v, bound);
  return op === "lt" ? c < 0 : op === "le" ? c <= 0 : op === "gt" ? c > 0 : op === "ge" ? c >= 0 : op === "eq" ? c === 0 : true;
};

export function affects(v: string, op?: Operator) {
  if (!op) return true;
  return test(v, op.min_operator, op.min_version) && test(v, op.max_operator, op.max_version);
}

const SEVERITY: Record<string, CareSeverity> = { c: "critical", h: "high", m: "medium", l: "low" };

function toVuln(component: CareVuln["component"], slug: string, name: string, installed: string, v: RawVuln): CareVuln {
  const cve = v.source?.find((s) => /^CVE-/.test(s.id))?.id ?? "";
  const link = v.source?.find((s) => /wordfence|patchstack|wpscan/.test(s.link))?.link ?? v.source?.[0]?.link ?? "";
  // Prefer a named advisory; CVE-only entries (typical for core) get the first sentence of the CVE text.
  const described = (v.source as { description?: string }[] | undefined)?.find((s) => s.description)?.description?.replace(/^\[en\]\s*/, "");
  const sentence = described?.split(/(?<=\.)\s/).find((x) => !/open publishing platform|^WordPress is a/i.test(x));
  const title = v.source?.find((s) => !/^CVE-/.test(s.id))?.name ?? (sentence ? sentence.slice(0, 220) : v.name);
  const score = v.impact?.cvss?.score ? Number(v.impact.cvss.score) : null;
  const sev = v.impact?.cvss?.severity ? SEVERITY[v.impact.cvss.severity] ?? "unknown" : score === null ? "unknown" : score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : "low";
  const op = v.operator;
  const unfixed = op?.unfixed === "1";
  // "< X" means X fixes it; "<= X" means the fix is whatever comes after X.
  const fixedIn = unfixed ? null : op?.max_operator === "lt" ? op.max_version : component === "core" ? "latest" : null;
  return { component, slug, name, installed, title: title.replace(/&#8211;/g, "–").replace(/&amp;/g, "&"), severity: sev, score, fixedIn, link, cve };
}

async function lookup(kind: "plugin" | "theme" | "core" | "php", key: string) {
  return cached(`vuln-${kind}-${key}`, async () => {
    const d = (await getJson(`https://www.wpvulnerability.net/${kind}/${encodeURIComponent(key)}/`)) as { data?: { vulnerability?: RawVuln[] | null; closed?: number | null; closed_reason?: string | null } };
    return { vulns: d.data?.vulnerability ?? [], closed: Boolean(d.data?.closed), closedReason: d.data?.closed_reason ?? "" };
  });
}

/** PHP branches: when security support ends (php.net supported versions). */
const PHP_EOL: Record<string, { active: string; security: string }> = {
  "7.4": { active: "2021-11-28", security: "2022-11-28" },
  "8.0": { active: "2022-11-26", security: "2023-11-26" },
  "8.1": { active: "2023-11-25", security: "2025-12-31" },
  "8.2": { active: "2024-12-31", security: "2026-12-31" },
  "8.3": { active: "2025-12-31", security: "2027-12-31" },
  "8.4": { active: "2026-12-31", security: "2028-12-31" },
  "8.5": { active: "2027-12-31", security: "2029-12-31" },
};

export function phpSupport(version: string): CareIntel["php"] {
  const branch = version.split(".").slice(0, 2).join(".");
  const row = PHP_EOL[branch];
  const today = new Date().toISOString().slice(0, 10);
  if (!row) return { version, status: Number(branch) < 7.4 ? "eol" : "unknown", endsAt: null };
  return { version, status: today > row.security ? "eol" : today > row.active ? "security" : "supported", endsAt: row.security };
}

export async function gatherIntel(status: CareStatus): Promise<CareIntel> {
  const vulns: CareVuln[] = [];
  const abandoned: CareAbandoned[] = [];

  const core = await lookup("core", status.core.version).catch(() => null);
  for (const v of core?.vulns ?? []) vulns.push(toVuln("core", "wordpress", "WordPress", status.core.version, v));

  for (const p of status.plugins) {
    const r = await lookup("plugin", p.slug).catch(() => null);
    if (!r) continue;
    for (const v of r.vulns) if (affects(p.version, v.operator)) vulns.push(toVuln("plugin", p.slug, p.name, p.version, v));
    if (r.closed) abandoned.push({ slug: p.slug, name: p.name, reason: "closed", detail: `Closed on wordpress.org${r.closedReason ? ` (${r.closedReason.replace(/-/g, " ")})` : ""}. It gets no more updates.` });
    else if (p.wporg) {
      const info = await cached(`wporg-${p.slug}`, async () => {
        const d = (await getJson(`https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=${encodeURIComponent(p.slug)}&request[fields][sections]=0&request[fields][versions]=0&request[fields][reviews]=0`)) as { last_updated?: string; error?: string; closed?: boolean };
        return { lastUpdated: d.last_updated ?? "", closed: Boolean(d.closed) };
      }).catch(() => null);
      if (info?.closed) abandoned.push({ slug: p.slug, name: p.name, reason: "closed", detail: "Closed on wordpress.org. It gets no more updates." });
      else if (info?.lastUpdated) {
        const d = new Date(info.lastUpdated.replace(/(\d+):(\d+)(am|pm) GMT/i, "$1:$2 $3 GMT"));
        const years = (Date.now() - d.getTime()) / (365 * 86400000);
        if (years >= 2) abandoned.push({ slug: p.slug, name: p.name, reason: "stale", detail: `No update in ${Math.floor(years)} years (last ${d.toISOString().slice(0, 10)}).` });
      }
    }
  }

  for (const t of status.themes) {
    const r = await lookup("theme", t.stylesheet).catch(() => null);
    for (const v of r?.vulns ?? []) if (affects(t.version, v.operator)) vulns.push(toVuln("theme", t.stylesheet, t.name, t.version, v));
  }

  const php = await lookup("php", status.env.php.split("-")[0]).catch(() => null);
  for (const v of php?.vulns ?? []) if (affects(status.env.php.split("-")[0], v.operator)) vulns.push(toVuln("php", "php", "PHP", status.env.php, v));

  const order: CareSeverity[] = ["critical", "high", "medium", "low", "unknown"];
  vulns.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  return { at: new Date().toISOString(), vulns, abandoned, php: phpSupport(status.env.php) };
}

/** Does moving to `to` fix at least one vulnerability that affects `from`? */
export async function updateFixesVuln(kind: "plugin" | "theme" | "core", slug: string, from: string, to: string) {
  const r = await lookup(kind, kind === "core" ? from : slug).catch(() => null);
  return (r?.vulns ?? []).some((v) => affects(from, v.operator) && !affects(to, v.operator));
}
