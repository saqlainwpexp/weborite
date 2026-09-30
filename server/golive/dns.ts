import { promises as dns } from "node:dns";

/** DNS over HTTPS (Cloudflare, then Google), so answers don't come from a stale local cache. Falls back to the system resolver. */
export async function lookup(name: string, type: "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "CAA"): Promise<string[]> {
  for (const base of ["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"]) {
    try {
      const r = await fetch(`${base}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const j = (await r.json()) as { Status: number; Answer?: { type: number; data: string }[] };
      const code = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28, CAA: 257 }[type];
      return (j.Answer ?? []).filter((a) => a.type === code).map((a) => (type === "TXT" ? a.data.replace(/^"|"$/g, "").replace(/"\s*"/g, "") : a.data.replace(/\.$/, "")));
    } catch {
      /* try the next resolver */
    }
  }
  try {
    switch (type) {
      case "A": return await dns.resolve4(name);
      case "AAAA": return await dns.resolve6(name);
      case "CNAME": return await dns.resolveCname(name);
      case "MX": return (await dns.resolveMx(name)).sort((a, b) => a.priority - b.priority).map((m) => `${m.priority} ${m.exchange}`);
      case "TXT": return (await dns.resolveTxt(name)).map((t) => t.join(""));
      case "NS": return await dns.resolveNs(name);
      case "CAA": return (await dns.resolveCaa(name)).map((c) => `${c.critical} ${Object.keys(c).find((k) => k !== "critical")} ${Object.values(c)[1]}`);
    }
  } catch {
    return [];
  }
}

/** MX hosts in priority order. */
export async function mxHosts(domain: string) {
  return (await lookup(domain, "MX")).map((m) => m.split(/\s+/)).sort((a, b) => Number(a[0]) - Number(b[0])).map((m) => (m[1] ?? m[0]).replace(/\.$/, ""));
}

/** Cloudflare's published edge ranges: a mail hostname resolving here is proxied, and mail can't get through. */
const FALLBACK_V4 = ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22"];
let ranges: { at: number; v4: string[]; v6: string[] } | null = null;

async function cfRanges() {
  if (ranges && Date.now() - ranges.at < 7 * 86400000) return ranges;
  try {
    const [v4, v6] = await Promise.all(["ips-v4", "ips-v6"].map((f) => fetch(`https://www.cloudflare.com/${f}`, { signal: AbortSignal.timeout(10000) }).then((r) => (r.ok ? r.text() : ""))));
    const list = (t: string) => t.split(/\s+/).filter((l) => l.includes("/"));
    ranges = { at: Date.now(), v4: list(v4).length ? list(v4) : FALLBACK_V4, v6: list(v6) };
  } catch {
    ranges = { at: Date.now(), v4: FALLBACK_V4, v6: [] };
  }
  return ranges;
}

const v4num = (ip: string) => ip.split(".").reduce((n, p) => n * 256 + Number(p), 0);
function v6big(ip: string) {
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const full = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  return full.reduce((n, p) => (n << 16n) + BigInt(parseInt(p || "0", 16)), 0n);
}

export function inCidr(ip: string, cidr: string) {
  const [net, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  if (ip.includes(":") !== net.includes(":")) return false;
  if (!ip.includes(":")) {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((v4num(ip) & mask) >>> 0) === ((v4num(net) & mask) >>> 0);
  }
  const mask = bits === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - bits)) - 1n);
  return (v6big(ip) & mask) === (v6big(net) & mask);
}

export async function isCloudflareIp(ip: string) {
  const r = await cfRanges();
  return (ip.includes(":") ? r.v6 : r.v4).some((c) => inCidr(ip, c));
}

/** A/AAAA for a host, following CNAMEs (DoH answers include the chain; we keep only addresses). */
export async function addresses(host: string) {
  const [a, aaaa] = await Promise.all([lookup(host, "A"), lookup(host, "AAAA")]);
  return [...a, ...aaaa].filter((x) => /^[\d.]+$|:/.test(x));
}
