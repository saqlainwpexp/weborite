import type { GoLiveRecord, SeoSite } from "../../shared/types.ts";
import { registrable } from "../care/health.ts";
import { readResult, writeResult } from "../seo/store.ts";

/** The five things only a person can judge, straight after cutover. */
export const HUMAN_CHECKS: { id: string; label: string; hint: string }[] = [
  { id: "inbox", label: "Submitted the form and saw it arrive in the client's own inbox", hint: "Submitted is not delivered. Open their inbox, not ours." },
  { id: "cold-read", label: "Read the homepage cold for 30 seconds: it doesn't read as machine-made", hint: "No filler, no generic claims, sounds like them." },
  { id: "photos", label: "The photographs are the client's own", hint: "No stock passing as their work." },
  { id: "facts", label: "The About story and every fact on the site is true", hint: "Dates, names, awards, prices, areas served." },
  { id: "pagespeed", label: "PageSpeed Insights on mobile scores 80+", hint: "The Performance tab measures this; confirm on the live domain." },
  { id: "favicon-16", label: "The favicon is legible at 16px", hint: "A wide logo squashed into a square isn't: make a simple mark in the brand colour." },
  { id: "client-mail", label: "Told the client their email apps work again", hint: "After mail records went DNS only." },
];

export function blankRecord(s: SeoSite): GoLiveRecord {
  return {
    oldSiteUrl: "",
    domain: registrable(new URL(s.siteUrl).hostname),
    hosting: { provider: "", account: "", clientOwns: false, newIp: "", notes: "" },
    track: "",
    domainInfo: { registrar: "", expires: "", tld: "", transfer: "", ipsTag: "", authCodeReceived: false, notes: "" },
    human: {},
    restoreTest: null,
    gsc: { verifiedAt: "", sitemapSubmittedAt: "", note: "" },
    cloudflare: { zoneId: "", zoneName: "", snapshotAt: "", cutoverAt: "", rolledBackAt: "", log: [] },
    redirects: [],
    redirectsPushedAt: "",
    mailTest: null,
    smtp: { host: "", port: 465, encryption: "ssl", username: "", from: "", savedAt: "" },
    wp: null,
    wpCheckedAt: "",
    kitLog: null,
    checks: [],
    checkedAt: "",
    liveAt: "",
  };
}

export function readRecord(s: SeoSite): GoLiveRecord {
  const blank = blankRecord(s);
  const r = readResult<Partial<GoLiveRecord>>(s.id, "golive") ?? {};
  return { ...blank, ...r, hosting: { ...blank.hosting, ...r.hosting }, domainInfo: { ...blank.domainInfo, ...r.domainInfo }, gsc: { ...blank.gsc, ...r.gsc }, cloudflare: { ...blank.cloudflare, ...r.cloudflare }, smtp: { ...blank.smtp, ...r.smtp } };
}

export function writeRecord(siteId: string, r: GoLiveRecord) {
  writeResult(siteId, "golive", r);
}

export function logDns(r: GoLiveRecord, lines: string[]) {
  const at = new Date().toISOString();
  r.cloudflare.log = [...lines.map((text) => ({ at, text })), ...r.cloudflare.log].slice(0, 200);
}
