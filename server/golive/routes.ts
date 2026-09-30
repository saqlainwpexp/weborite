import { randomBytes } from "node:crypto";
import { Router } from "express";
import { addEvent, getSettings } from "../db.ts";
import type { DnsRecordLite, GoLiveRecord, SeoSite } from "../../shared/types.ts";
import { domainInfo } from "../care/health.ts";
import { discoverPages, fromSitemap } from "../seo/crawl.ts";
import { siteAuth } from "../seo/routes.ts";
import { getSite, readResult, writeResult } from "../seo/store.ts";
import { WpError, goliveKit, goliveLive, goliveMailtest, goliveRedirects, goliveSmtp, goliveStatus, ping } from "../wp/client.ts";
import { runChecks } from "./checks.ts";
import { addresses, lookup, mxHosts } from "./dns.ts";
import { authResults, findMessageHeaders } from "./imap.ts";
import { oldSiteUrls, proposeRedirects } from "./redirects.ts";
import { smtpProbe } from "./smtp.ts";
import { HUMAN_CHECKS, logDns, readRecord, writeRecord } from "./store.ts";

/* ---------- one background job per site ---------- */

type JobState = { kind: string; note: string; startedAt: string; error?: string; finishedAt?: string };
const jobs = new Map<string, JobState>();

function start(res: import("express").Response, s: SeoSite, kind: string, run: (rec: GoLiveRecord, note: (n: string) => void) => Promise<string>) {
  const cur = jobs.get(s.id);
  if (cur && !cur.finishedAt) return res.status(409).json({ error: `Wait for “${cur.kind}” to finish` });
  const job: JobState = { kind, note: "Starting…", startedAt: new Date().toISOString() };
  jobs.set(s.id, job);
  void (async () => {
    try {
      const rec = readRecord(s);
      const done = await run(rec, (n) => (job.note = n));
      writeRecord(s.id, rec);
      job.note = done;
      addEvent({ leadId: null, kind: "info", title: `Go-live: ${kind}`, detail: `${s.name}: ${done}` });
    } catch (e) {
      job.error = (e as Error).message.slice(0, 400);
      console.error(`[golive ${s.id} ${kind}]`, e);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  })();
  res.json({ ok: true, job });
}

const imap = () => {
  const s = getSettings() as unknown as { qaImapHost: string; qaImapPort: number; qaImapUser: string; qaImapPassword: string };
  return s.qaImapHost && s.qaImapUser && s.qaImapPassword ? { host: s.qaImapHost, port: s.qaImapPort || 993, user: s.qaImapUser, password: s.qaImapPassword } : null;
};

async function refreshWp(s: SeoSite, rec: GoLiveRecord) {
  const p = await ping(siteAuth(s));
  if (!p.golive) throw new WpError("The connector on this site is too old for the go-live kit. Download the plugin again from the Launch & SEO page and upload it under Plugins → Add New → Upload Plugin.", 409);
  rec.wp = await goliveStatus(siteAuth(s));
  rec.wpCheckedAt = new Date().toISOString();
}

type Snapshot = { at: string; zone: string; nameservers: string[]; records: DnsRecordLite[] };

/** Registrar transfer method by TLD: .uk moves by IPS tag, almost everything else by auth (EPP) code. */
export function transferMethod(domain: string) {
  return /\.uk$/i.test(domain) ? "ips-tag" as const : "auth-code" as const;
}

async function transferPlan(s: SeoSite, rec: GoLiveRecord) {
  const d = rec.domain;
  const snap = readResult<Snapshot>(s.id, "dns-snapshot");
  const ns = await lookup(d, "NS");
  const [a, www, mx, txt, dmarc, mail] = await Promise.all([lookup(d, "A"), lookup(`www.${d}`, "A"), mxHosts(d), lookup(d, "TXT"), lookup(`_dmarc.${d}`, "TXT"), lookup(`mail.${d}`, "A")]);
  const now = new Date().toISOString().slice(0, 10);
  const oldA = snap?.records.filter((r) => r.name === d && r.type === "A").map((r) => r.content) ?? a;
  const oldWww = snap?.records.filter((r) => r.name === `www.${d}`).map((r) => `${r.type} ${r.content}`) ?? www.map((x) => `A ${x}`);
  const method = rec.domainInfo.transfer || transferMethod(d);
  const L: string[] = [
    `# ${s.name}: transfer plan (${d})`,
    `Generated ${now} by Weborite Studio.`,
    "",
    "## Where things are",
    `- Hosting: ${rec.hosting.provider || "(not recorded)"}${rec.hosting.account ? `, account \`${rec.hosting.account}\`` : ""}${rec.hosting.clientOwns ? " (client's own account, confirmed)" : " (**confirm this is the client's own account before building**)"}`,
    `- Build track: ${rec.track === "A" ? "A (Studio Elementor build)" : rec.track === "B" ? "B (existing theme or builder kept)" : "(not recorded)"}`,
    `- DNS is edited at: ${ns.join(", ") || "no nameservers found"}${rec.domainInfo.registrar ? ` (registrar: ${rec.domainInfo.registrar})` : ""}`,
    `- New host IP: ${rec.hosting.newIp || "(not recorded)"}`,
    "",
    "## Current records (rollback values)",
    `- A ${d}: ${oldA.join(", ") || "none"}`,
    `- www.${d}: ${oldWww.join(", ") || "none"}`,
    `- MX: ${mx.join(", ") || "none"}`,
    `- mail.${d}: ${mail.join(", ") || "none"}`,
    `- SPF: ${txt.find((t) => /^v=spf1/i.test(t)) ?? "none"}`,
    `- DMARC: ${dmarc[0] ?? "none"}`,
    snap ? `- Snapshot taken ${snap.at.slice(0, 16).replace("T", " ")} (${snap.records.length} records, downloadable from the app)` : "- **Take a DNS snapshot in the app before changing anything.**",
    "",
  ];
  L.push(
    "## Before cutover",
    "1. mail. and MX hosts point straight at the mail server (no web proxy); mail apps connect over IMAP and SMTP (app: Email checks).",
    "2. FluentSMTP sending as the client's own address; delivery test shows SPF pass in an outside inbox.",
    `3. old.${d} added as an A record to the current host (${oldA[0] ?? "old IP"}) and loading the outgoing site.`,
    "4. Redirect map pushed to the new site.",
    "5. A complete backup with remote storage.",
    "",
    "## Cutover",
    `1. At the DNS provider, change **A ${d} and www only** to ${rec.hosting.newIp || "the new host's IP"}. Leave mail., MX and TXT alone. Lower the TTL to 300 a day before if the provider allows it.`,
    "2. Remove the staging password and allow search engines (app: Go live).",
    "3. SSL valid on root and www; run the go-live checks: zero failures.",
    "",
    "## Rollback",
    `1. Set A ${d} back to ${oldA.join(", ") || "the snapshot value"} and www back to ${oldWww.join(", ") || "the snapshot value"}.`,
    "2. Mail is unaffected: it never moved.",
    "3. Note what failed, fix it on staging, and cut over again.",
    "",
    "## Domain transfer (no urgency)",
    method === "ips-tag"
      ? `- ${d} is a .uk domain: it moves by **IPS tag**, not an auth code. Ask the new registrar for its IPS tag and set it at the current registrar.`
      : `- ${d} moves with an **auth (EPP) code**: unlock the domain at the current registrar, request the code, and start the transfer at the new one. Transfers aren't possible within 60 days of registration or a previous transfer.`,
    `- Expiry: ${rec.domainInfo.expires ? rec.domainInfo.expires.slice(0, 10) : "(look up)"}. Schedule the transfer well before then.`,
  );
  return L.join("\n") + "\n";
}

/* ---------- routes ---------- */

export const golive = Router();

golive.get("/:id", (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  const st = getSettings() as unknown as { agencyAdminEmail: string; qaImapHost: string; qaEmail: string; userEmail: string };
  const snap = readResult<Snapshot>(s.id, "dns-snapshot");
  res.json({
    record: readRecord(s),
    job: jobs.get(s.id) ?? null,
    human: HUMAN_CHECKS,
    snapshot: snap ? { at: snap.at, count: snap.records.length, nameservers: snap.nameservers, root: snap.records.filter((r) => r.name === snap.zone && ["A", "AAAA"].includes(r.type)).map((r) => `${r.type} ${r.content}`), www: snap.records.filter((r) => r.name === `www.${snap.zone}`).map((r) => `${r.type} ${r.content}`) } : null,
    setup: { agencyAdminEmail: st.agencyAdminEmail, imap: Boolean(imap()), qaEmail: st.qaEmail || st.userEmail },
  });
});

/** Project facts people record: hosting, track, domain, human checks, restore test, GSC, redirect edits. */
golive.put("/:id", (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  const rec = readRecord(s);
  const b = req.body ?? {};
  const str = (v: unknown, max = 300) => String(v ?? "").trim().slice(0, max);
  if (b.oldSiteUrl !== undefined) {
    const v = str(b.oldSiteUrl);
    try {
      rec.oldSiteUrl = v ? new URL(/^https?:/.test(v) ? v : `https://${v}`).origin : "";
    } catch {
      return res.status(400).json({ error: "Enter the old site's address, e.g. https://example.com" });
    }
  }
  if (b.domain !== undefined) rec.domain = str(b.domain, 120).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (b.hosting) rec.hosting = { provider: str(b.hosting.provider ?? rec.hosting.provider), account: str(b.hosting.account ?? rec.hosting.account), clientOwns: b.hosting.clientOwns ?? rec.hosting.clientOwns, newIp: str(b.hosting.newIp ?? rec.hosting.newIp, 45), notes: str(b.hosting.notes ?? rec.hosting.notes, 2000) };
  if (b.track !== undefined && ["", "A", "B"].includes(b.track)) rec.track = b.track;
  if (b.domainInfo) rec.domainInfo = { ...rec.domainInfo, ...Object.fromEntries(Object.entries(b.domainInfo).filter(([k]) => k in rec.domainInfo)) } as GoLiveRecord["domainInfo"];
  if (b.human && typeof b.human === "object") {
    for (const [id, v] of Object.entries(b.human as Record<string, { done?: boolean; note?: string }>)) {
      if (!HUMAN_CHECKS.some((h) => h.id === id)) continue;
      rec.human[id] = { done: Boolean(v?.done), note: str(v?.note, 500), at: new Date().toISOString() };
    }
  }
  if (b.restoreTest !== undefined) rec.restoreTest = b.restoreTest ? { at: str(b.restoreTest.at) || new Date().toISOString(), note: str(b.restoreTest.note, 500) } : null;
  if (b.gsc) rec.gsc = { ...rec.gsc, ...Object.fromEntries(Object.entries(b.gsc).filter(([k]) => k in rec.gsc).map(([k, v]) => [k, str(v)])) };
  if (Array.isArray(b.redirects)) rec.redirects = b.redirects.map((r: { from?: string; to?: string; note?: string }) => ({ from: str(r.from, 500), to: str(r.to, 500), note: str(r.note, 200) })).filter((r: { from: string; to: string }) => r.from && r.to).slice(0, 1000);
  writeRecord(s.id, rec);
  res.json(rec);
});

golive.post("/:id/wp", async (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  try {
    const rec = readRecord(s);
    await refreshWp(s, rec);
    writeRecord(s.id, rec);
    res.json(rec);
  } catch (e) {
    res.status(e instanceof WpError && e.status ? e.status : 400).json({ error: (e as Error).message });
  }
});

golive.post("/:id/kit", (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  const steps = (Array.isArray(req.body?.steps) ? req.body.steps : []).filter((x: string) => ["plugins", "backups", "security", "admin", "forms", "webp", "llms"].includes(x));
  if (!steps.length) return res.status(400).json({ error: "Pick at least one part of the kit" });
  const admin = (getSettings() as unknown as { agencyAdminEmail: string }).agencyAdminEmail;
  if (steps.includes("admin") && !admin) return res.status(400).json({ error: "Set the agency admin email under Settings → Integrations first" });
  start(res, s, "Go-live kit", async (rec, note) => {
    await refreshWp(s, rec);
    note("Installing and configuring…");
    const r = await goliveKit(siteAuth(s), { steps, admin_email: admin, user_email: Boolean(req.body?.userEmail), form_recipient: String(req.body?.formRecipient ?? "") });
    rec.wp = r.status;
    rec.wpCheckedAt = new Date().toISOString();
    rec.kitLog = { at: new Date().toISOString(), steps: r.steps };
    const bad = r.steps.filter((x) => !x.ok);
    return `${r.steps.length - bad.length}/${r.steps.length} steps done${bad.length ? `; ${bad.map((b) => b.note).join("; ")}` : ""}`;
  });
});

golive.post("/:id/smtp", async (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  const b = req.body ?? {};
  const body = { sender_name: String(b.name ?? s.name), sender_email: String(b.from ?? ""), host: String(b.host ?? ""), port: Number(b.port) || 465, encryption: ["ssl", "tls", "none"].includes(b.encryption) ? b.encryption : "ssl", username: String(b.username || b.from || ""), password: String(b.password ?? "") };
  if (!body.password) return res.status(400).json({ error: "Enter the mailbox password (it's saved in FluentSMTP on the site, not in the app)" });
  try {
    const auth = siteAuth(s);
    let r;
    try {
      r = await goliveSmtp(auth, body);
    } catch (e) {
      // FluentSMTP was installed by this very request; its classes load on the next one.
      if (e instanceof WpError && e.status === 409) r = await goliveSmtp(auth, body);
      else throw e;
    }
    const rec = readRecord(s);
    rec.smtp = { host: body.host, port: body.port, encryption: body.encryption as "ssl", username: body.username, from: body.sender_email, savedAt: new Date().toISOString() };
    rec.wp = r.status;
    rec.wpCheckedAt = new Date().toISOString();
    writeRecord(s.id, rec);
    res.json({ ...r, record: rec });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** Sends a real email through the site, then reads it from the QA inbox to confirm delivery and SPF/DKIM. */
golive.post("/:id/mailtest", (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  const box = imap();
  const st = getSettings();
  const to = String(req.body?.to || (box ? box.user : "") || st.qaEmail || st.userEmail || "");
  if (!to.includes("@")) return res.status(400).json({ error: "Set a QA inbox under Settings → Integrations (an outside mailbox like Gmail, with an app password)" });
  start(res, s, "Delivery test", async (rec, note) => {
    const token = randomBytes(5).toString("hex").toUpperCase();
    note(`Sending through the site to ${to}…`);
    const sent = await goliveMailtest(siteAuth(s), { to, token });
    const test = { at: new Date().toISOString(), token, to, sent: sent.sent, mailer: sent.mailer, error: sent.error, received: null as boolean | null, spf: "", dkim: "", dmarc: "", from: "", detail: "" };
    rec.mailTest = test;
    if (!sent.sent) {
      test.detail = `WordPress couldn't send: ${sent.error || "wp_mail returned false"} (${sent.mailer})`;
      return test.detail;
    }
    if (!box || box.user.toLowerCase() !== to.toLowerCase()) {
      test.detail = `Sent via ${sent.mailer} to ${to}. Open that inbox and check the headers for “spf=pass” (no QA inbox connected to read it automatically).`;
      return test.detail;
    }
    for (let i = 0; i < 18; i++) {
      note(`Waiting for it to arrive (${i * 10}s)…`);
      await new Promise((r) => setTimeout(r, 10000));
      const found = await findMessageHeaders(box, token).catch((e: Error) => {
        throw new Error(`Couldn't read the QA inbox: ${e.message}`);
      });
      if (!found) continue;
      const a = authResults(found.headers);
      Object.assign(test, { received: true, spf: a.spf, dkim: a.dkim, dmarc: a.dmarc, from: a.from });
      const spam = found.folder !== "INBOX";
      test.detail = `Arrived${spam ? ` in ${found.folder} (spam)` : ""} from ${a.from || "?"} via ${sent.mailer}: SPF ${a.spf || "not reported"}, DKIM ${a.dkim || "not reported"}, DMARC ${a.dmarc || "not reported"}`;
      return test.detail;
    }
    test.received = false;
    test.detail = `Sent via ${sent.mailer}, but nothing arrived at ${to} within 3 minutes (checked inbox and spam). Mail from this site isn't getting out.`;
    return test.detail;
  });
});

golive.post("/:id/checks", (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  start(res, s, "Go-live checks", async (rec, note) => {
    note("Reading the site's WordPress setup…");
    await refreshWp(s, rec).catch(() => undefined);
    note("Checking security, SEO, cookies, SSL, DNS and mail…");
    const admin = (getSettings() as unknown as { agencyAdminEmail: string }).agencyAdminEmail;
    rec.checks = await runChecks(s.siteUrl, rec, admin);
    rec.checkedAt = new Date().toISOString();
    const fails = rec.checks.filter((c) => c.status === "fail").length;
    return fails ? `${fails} failures, ${rec.checks.filter((c) => c.status === "pass").length} passing` : `Zero failures (${rec.checks.filter((c) => c.status === "pass").length} passing)`;
  });
});

golive.post("/:id/redirects/build", (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  const rec = readRecord(s);
  if (!rec.oldSiteUrl) return res.status(400).json({ error: "Enter the old site's address first (before cutover it's the live domain; after, old." + rec.domain + ")" });
  start(res, s, "Redirect map", async (r, note) => {
    note(`Listing every URL on ${r.oldSiteUrl}…`);
    const old = await oldSiteUrls(r.oldSiteUrl);
    note("Listing the new site's pages…");
    const origin = new URL(s.siteUrl).origin;
    const pages = s.pages.length ? s.pages.map((p) => p.url) : (await discoverPages(s.siteUrl)).map((p) => p.url);
    const all = [...new Set([...pages, ...(await fromSitemap(origin, true))])].map((u) => new URL(u).pathname);
    const proposed = proposeRedirects(old, all);
    // Keep edits already made to a path.
    const edited = new Map(r.redirects.map((x) => [x.from, x]));
    r.redirects = proposed.map((p) => edited.get(p.from) ?? p);
    for (const [from, x] of edited) if (!r.redirects.some((y) => y.from === from)) r.redirects.push(x);
    return `${old.length} old URLs, ${r.redirects.length} need a redirect`;
  });
});

golive.post("/:id/redirects/push", async (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  const rec = readRecord(s);
  try {
    const r = await goliveRedirects(siteAuth(s), rec.redirects.map(({ from, to }) => ({ from, to })));
    rec.redirectsPushedAt = new Date().toISOString();
    writeRecord(s.id, rec);
    res.json({ ...r, record: rec });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

golive.post("/:id/domain/lookup", async (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  const rec = readRecord(s);
  const d = await domainInfo(rec.domain);
  rec.domainInfo.tld = rec.domain.split(".").slice(-(/\.(co|org|me|ltd|plc|net)\.uk$/.test(rec.domain) ? 2 : 1)).join(".");
  if (!rec.domainInfo.transfer) rec.domainInfo.transfer = transferMethod(rec.domain);
  if (d) {
    rec.domainInfo.registrar = d.registrar || rec.domainInfo.registrar;
    rec.domainInfo.expires = d.expires;
  }
  writeRecord(s.id, rec);
  res.json(d ? rec : { ...rec, warning: "The registry didn't return an expiry date. Enter it from the registrar." });
});

/* ---------- DNS: any provider. The app records, instructs and verifies; the records are changed at the provider. ---------- */

const DKIM = ["default", "google", "selector1", "selector2", "k1", "s1", "s2", "mail", "dkim", "hostingermail1", "hostingermail2", "zoho", "titan1"];

/** Everything public DNS shows for the names that matter (a zone can't be listed from outside, so these are the known names). */
async function publicRecords(d: string): Promise<DnsRecordLite[]> {
  const names: [string, ("A" | "AAAA" | "CNAME" | "MX" | "TXT" | "CAA")[]][] = [
    [d, ["A", "AAAA", "MX", "TXT", "CAA"]],
    [`www.${d}`, ["CNAME", "A", "AAAA"]],
    ...["mail", "smtp", "imap", "pop", "webmail", "autodiscover", "autoconfig", "cpanel", "ftp", "old"].map((l) => [`${l}.${d}`, ["CNAME", "A"]] as [string, ("A" | "CNAME")[]]),
    [`_dmarc.${d}`, ["TXT"]],
    ...DKIM.map((sel) => [`${sel}._domainkey.${d}`, ["CNAME", "TXT"]] as [string, ("CNAME" | "TXT")[]]),
  ];
  const out: DnsRecordLite[] = [];
  await Promise.all(names.map(async ([name, types]) => {
    for (const type of types) {
      const vals = await lookup(name, type);
      // A CNAME answer also carries the target's addresses: keep the CNAME and skip the rest for that name.
      if (type === "CNAME" && vals.length) {
        out.push({ type, name, content: vals[0] });
        return;
      }
      for (const v of vals) {
        if (type === "MX") {
          const [prio, host] = v.split(/\s+/);
          out.push({ type, name, content: host ?? prio, priority: Number(prio) || undefined });
        } else if ((type === "A" && /^[\d.]+$/.test(v)) || (type === "AAAA" && v.includes(":")) || !["A", "AAAA"].includes(type)) out.push({ type, name, content: v });
      }
    }
  }));
  const order = (r: DnsRecordLite) => (r.name === d ? "0" : r.name.startsWith("www.") ? "1" : r.name) + r.type;
  return out.sort((x, y) => order(x).localeCompare(order(y)));
}

golive.post("/:id/dns/snapshot", async (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  const rec = readRecord(s);
  if (!rec.domain) return res.status(400).json({ error: "Enter the live domain under Project first" });
  const snap: Snapshot = { at: new Date().toISOString(), zone: rec.domain, nameservers: await lookup(rec.domain, "NS"), records: await publicRecords(rec.domain) };
  const prev = readResult<Snapshot>(s.id, "dns-snapshot");
  writeResult(s.id, `dns-snapshot-${snap.at.replace(/[:.]/g, "-")}`, snap);
  // After cutover the first snapshot is the rollback point: keep it, and store this one alongside.
  const keepOld = prev && rec.dns.cutoverAt && !rec.dns.rolledBackAt;
  if (!keepOld) {
    writeResult(s.id, "dns-snapshot", snap);
    rec.dns.snapshotAt = snap.at;
  }
  const rootA = snap.records.filter((r) => r.name === rec.domain && r.type === "A").map((r) => r.content);
  const www = snap.records.filter((r) => r.name === `www.${rec.domain}`).map((r) => `${r.type} ${r.content}`);
  const lines = keepOld ? [`Snapshot of ${snap.records.length} records saved (the pre-cutover snapshot stays the rollback point)`]
    : [`Snapshot of ${snap.records.length} records saved`, `Rollback values: A ${rec.domain} → ${rootA.join(", ") || "none"}; www → ${www.join(", ") || "none"}`];
  logDns(rec, lines);
  writeRecord(s.id, rec);
  res.json({ lines, record: rec });
});

/** What the world sees right now for the site, www, old. and mail, against what the plan expects. */
golive.post("/:id/dns/verify", async (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  const rec = readRecord(s);
  const d = rec.domain;
  const snap = readResult<Snapshot>(s.id, "dns-snapshot");
  const oldIps = snap?.records.filter((r) => r.name === d && ["A", "AAAA"].includes(r.type)).map((r) => r.content) ?? [];
  const [root, www, wwwCname, old, mx] = await Promise.all([addresses(d), addresses(`www.${d}`), lookup(`www.${d}`, "CNAME"), addresses(`old.${d}`), mxHosts(d)]);
  const ip = rec.hosting.newIp;
  const lines: { ok: boolean | null; text: string }[] = [];
  const at = (list: string[]) => list.join(", ") || "nothing";
  if (ip) {
    const rootNew = root.includes(ip);
    const stale = root.filter((x) => oldIps.includes(x));
    lines.push({ ok: rootNew && !stale.length ? true : rec.dns.cutoverAt ? false : null, text: `${d} → ${at(root)}${rootNew ? (stale.length ? ` (the old ${stale.join(", ")} is still there: remove it)` : " (new host)") : ` (not ${ip} yet)`}` });
    const wwwNew = www.includes(ip) || wwwCname.some((c) => c === d);
    lines.push({ ok: wwwNew ? true : rec.dns.cutoverAt ? false : null, text: `www.${d} → ${wwwCname.length ? `CNAME ${wwwCname[0]} → ` : ""}${at(www)}${wwwNew ? "" : ` (not ${ip} yet)`}` });
    if (!rootNew && root.some((x) => !oldIps.includes(x)) && oldIps.length) lines.push({ ok: null, text: "The address isn't the new host or the snapshot's old one: a proxy (e.g. Cloudflare) may hide the origin. The go-live checks confirm which site answers." });
  } else lines.push({ ok: null, text: "Record the new host's IP under Project to verify the cutover" });
  lines.push({ ok: old.length ? (oldIps.length && old.some((x) => oldIps.includes(x)) ? true : null) : null, text: old.length ? `old.${d} → ${at(old)}${oldIps.length && old.some((x) => oldIps.includes(x)) ? " (the old host)" : ""}` : `old.${d} doesn't exist yet` });
  const mxOwn = mx.filter((m) => m.endsWith(d));
  lines.push({ ok: mx.length > 0, text: `MX → ${at(mx)}${mxOwn.length ? "" : mx.length ? " (mail hosted by a provider)" : ""}` });
  rec.dns.verify = { at: new Date().toISOString(), lines };
  writeRecord(s.id, rec);
  res.json({ record: rec });
});

/** The records were changed at the provider: note when (the checks then expect the new host). */
golive.post("/:id/dns/mark", (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  const rec = readRecord(s);
  const what = String(req.body?.what ?? "");
  if (what === "cutover") {
    if (!readResult<Snapshot>(s.id, "dns-snapshot")) return res.status(400).json({ error: "Take a DNS snapshot first: it's the record of what to put back" });
    rec.dns.cutoverAt = new Date().toISOString();
    rec.dns.rolledBackAt = "";
    logDns(rec, [`Cutover recorded: A ${rec.domain} and www → ${rec.hosting.newIp || "new host"}`]);
  } else if (what === "rollback") {
    rec.dns.rolledBackAt = new Date().toISOString();
    rec.liveAt = "";
    logDns(rec, ["Rollback recorded: root and www put back to the snapshot values"]);
  } else return res.status(400).json({ error: "Unknown step" });
  writeRecord(s.id, rec);
  res.json({ record: rec });
});

golive.get("/:id/dns/snapshot.txt", (req, res) => {
  const s = getSite(req.params.id);
  const snap = s && readResult<Snapshot>(s.id, "dns-snapshot");
  if (!snap) return res.sendStatus(404);
  const rows = snap.records.map((r) => `${r.name}.\tIN\t${r.type}\t${r.priority !== undefined ? r.priority + " " : ""}${r.content}`);
  res.type("text/plain").attachment(`${snap.zone}-dns-${snap.at.slice(0, 10)}.txt`).send(`; ${snap.zone} as public DNS showed it on ${snap.at}\n; Nameservers: ${snap.nameservers.join(", ")}\n${rows.join("\n")}\n`);
});

/** Direct SMTP login test with the mailbox details, before they're saved to FluentSMTP. */
golive.post("/:id/smtp/test", async (req, res) => {
  const b = req.body ?? {};
  const host = String(b.host ?? "").trim();
  if (!host) return res.status(400).json({ error: "Enter the SMTP host" });
  const enc = ["ssl", "tls", "none"].includes(b.encryption) ? b.encryption : "ssl";
  const r = await smtpProbe(host, Number(b.port) || 465, enc, b.password ? { user: String(b.username || b.from || ""), password: String(b.password) } : undefined);
  res.json(r);
});

golive.get("/:id/plan", async (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  const text = await transferPlan(s, readRecord(s));
  if (req.query.download) res.attachment(`${readRecord(s).domain}-transfer-plan-${new Date().toISOString().slice(0, 10)}.md`);
  res.type("text/markdown").send(text);
});

/** Cutover on the WordPress side: allow indexing and take the staging password down. */
golive.post("/:id/live", async (req, res) => {
  const s = getSite(req.params.id);
  if (!s) return res.sendStatus(404);
  try {
    const r = await goliveLive(siteAuth(s), { index: req.body?.index !== false, remove_auth: req.body?.removeAuth !== false });
    const rec = readRecord(s);
    rec.wp = r.status;
    rec.wpCheckedAt = new Date().toISOString();
    rec.liveAt = new Date().toISOString();
    writeRecord(s.id, rec);
    res.json({ ...r, record: rec });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
