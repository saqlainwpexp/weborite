import { connect } from "node:tls";
import type { GoLiveCheck, GoLiveRecord, GoLiveStatus } from "../../shared/types.ts";
import { dirListing, domainInfo, registrable } from "../care/health.ts";
import { newContext } from "../pipeline/browser.ts";
import { archiveUrls, UA } from "../seo/crawl.ts";
import { addresses, isCloudflareIp, lookup, mxHosts } from "./dns.ts";
import { smtpProbe } from "./smtp.ts";

type Res = { status: number; headers: Headers; text: string; location: string };

async function get(url: string, init: RequestInit = {}): Promise<Res | null> {
  try {
    const r = await fetch(url, { redirect: "manual", headers: { "User-Agent": UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20000), ...init });
    const text = r.status >= 300 && r.status < 400 ? "" : await r.text();
    return { status: r.status, headers: r.headers, text, location: r.headers.get("location") ?? "" };
  } catch {
    return null;
  }
}

/** Follow redirects ourselves (fetch's manual mode hides the chain). */
async function follow(url: string, hops = 6) {
  const chain: { url: string; status: number }[] = [];
  let cur = url;
  for (let i = 0; i < hops; i++) {
    const r = await get(cur);
    if (!r) return { chain, final: null as Res | null };
    chain.push({ url: cur, status: r.status });
    if (r.status >= 300 && r.status < 400 && r.location) cur = new URL(r.location, cur).href;
    else return { chain, final: r };
  }
  return { chain, final: null as Res | null };
}

/** TLS handshake with hostname verification: is the certificate valid for this exact name? */
export function tlsCheck(host: string, port = 443): Promise<{ ok: boolean; detail: string; daysLeft?: number }> {
  return new Promise((resolve) => {
    const s = connect({ host, port, servername: host, timeout: 15000, rejectUnauthorized: false }, () => {
      const cert = s.getPeerCertificate();
      const err = s.authorizationError;
      s.end();
      const days = cert?.valid_to ? Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86400000) : undefined;
      if (err) resolve({ ok: false, detail: `${host}:${port} certificate problem: ${String(err)}`, daysLeft: days });
      else resolve({ ok: true, detail: `${host}:${port} valid${days !== undefined ? `, ${days} days left` : ""}`, daysLeft: days });
    });
    s.on("error", (e) => resolve({ ok: false, detail: `${host}:${port} ${(e as NodeJS.ErrnoException).code ?? e.message}` }));
    s.on("timeout", () => {
      s.destroy();
      resolve({ ok: false, detail: `${host}:${port} didn't answer` });
    });
  });
}

const TRACKING_COOKIE = /^(_ga|_gid|_gat|_gcl_|_fbp|_fbc|fr$|_hj|hubspotutk|__hs|_clck|_clsk|_uetsid|_uetvid|_tt_|_pin_|IDE$|test_cookie$|_scid|li_)/i;
const CMP = /cookieyes|cookie-law-info|complianz|cookiebot|termly|iubenda|borlabs|moove_gdpr|gdpr-cookie|osano|onetrust|cookie-notice|cookieconsent|usercentrics|cookiefirst|real-cookie-banner|cmplz/i;

/** Cookies set before any consent, and whether a consent tool is on the page. */
async function cookieAudit(url: string) {
  const ctx = await newContext({ userAgent: UA });
  try {
    const page = await ctx.newPage();
    const html: string[] = [];
    page.on("response", (r) => {
      if (/\.js(\?|$)/.test(r.url()) && CMP.test(r.url())) html.push(r.url());
    });
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => undefined);
    await page.waitForTimeout(2500);
    const content = await page.content();
    const cookies = await ctx.cookies();
    const trackers = cookies.filter((c) => TRACKING_COOKIE.test(c.name));
    const thirdParty = cookies.filter((c) => !url.includes(c.domain.replace(/^\./, "")));
    const trackerScripts = /googletagmanager\.com|google-analytics\.com|connect\.facebook\.net|hotjar|clarity\.ms|hs-scripts|tiktok|snap\.licdn|analytics\.js|gtag\(/i.test(content);
    return { cookies: cookies.map((c) => c.name), trackers: trackers.map((c) => c.name), thirdParty: thirdParty.map((c) => `${c.name} (${c.domain})`), cmp: CMP.test(content) || html.length > 0, trackerScripts, privacyLink: /href="[^"]*privacy[^"]*"/i.test(content) };
  } finally {
    await ctx.close();
  }
}

const DKIM_SELECTORS = ["default", "google", "selector1", "selector2", "k1", "k2", "s1", "s2", "mail", "dkim", "hostingermail1", "hostingermail2", "zoho", "zmail", "protonmail", "fm1", "mxvault", "x", "smtp", "sendgrid", "mandrill", "mailjet", "everlytickey1", "titan1", "resend"];

/** Every check the go-live list asks for that can be measured from outside. */
export async function runChecks(siteUrl: string, rec: GoLiveRecord, adminEmail: string): Promise<GoLiveCheck[]> {
  const out: GoLiveCheck[] = [];
  const add = (group: GoLiveCheck["group"], id: string, label: string, status: GoLiveStatus, detail: string) => out.push({ id, group, label, status, detail });
  const origin = new URL(siteUrl).origin;
  const host = new URL(siteUrl).hostname;
  const domain = rec.domain || registrable(host);
  const wp = rec.wp;

  const home = await get(origin + "/");
  const html = home?.text ?? "";

  /* ---- Security ---- */
  if (home) {
    const h = home.headers;
    const missing = [
      !/nosniff/i.test(h.get("x-content-type-options") ?? "") && "X-Content-Type-Options",
      !h.get("x-frame-options") && !/frame-ancestors/i.test(h.get("content-security-policy") ?? "") && "X-Frame-Options",
      !h.get("referrer-policy") && "Referrer-Policy",
      origin.startsWith("https") && !h.get("strict-transport-security") && "Strict-Transport-Security",
    ].filter(Boolean) as string[];
    add("Security", "headers", "Security headers sent", missing.length ? "fail" : "pass", missing.length ? `Missing: ${missing.join(", ")}` : "nosniff, frame, referrer and HSTS headers present");
  } else add("Security", "headers", "Security headers sent", "fail", "The homepage didn't load");

  const users = await get(origin + "/wp-json/wp/v2/users");
  const usersList = users && users.status === 200 && /"slug"\s*:/.test(users.text);
  add("Security", "users-endpoint", "REST API doesn't list usernames", usersList ? "fail" : "pass", usersList ? "/wp-json/wp/v2/users shows usernames to anyone" : `Blocked (${users?.status ?? "no answer"})`);

  const author = await get(origin + "/?author=1");
  const leaks = author && author.status >= 300 && author.status < 400 && /\/author\//i.test(author.location);
  add("Security", "author-enum", "?author=1 doesn't reveal a username", leaks ? "fail" : "pass", leaks ? `Redirects to ${new URL(author!.location, origin).pathname}` : "No username in the redirect");

  const readme = await Promise.all(["/readme.html", "/license.txt", "/wp-config-sample.php"].map(async (p) => [p, (await get(origin + p))?.status ?? 0] as const));
  const open = readme.filter(([, s]) => s === 200).map(([p]) => p);
  add("Security", "readme", "readme.html, license.txt and wp-config-sample.php blocked", open.length ? "fail" : "pass", open.length ? `Public: ${open.join(", ")}` : "Blocked");

  const generator = /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*WordPress[^"']*["']/i.exec(html);
  add("Security", "generator", "WordPress version not shown", generator ? "fail" : "pass", generator ? generator[0].replace(/.*content=["']([^"']+).*/i, "$1") : "No generator tag");

  const xml = await get(origin + "/xmlrpc.php", { method: "POST", headers: { "Content-Type": "text/xml" }, body: "<?xml version=\"1.0\"?><methodCall><methodName>system.listMethods</methodName></methodCall>" });
  const xmlOpen = xml && xml.status === 200 && /<methodResponse>[\s\S]*<string>/i.test(xml.text);
  add("Security", "xmlrpc", "XML-RPC switched off", xmlOpen ? "fail" : "pass", xmlOpen ? "xmlrpc.php answers method calls (brute-force target)" : `Off (${xml?.status ?? "no answer"})`);

  add("Security", "dir-listing", "No directory listings", (await dirListing(origin)) ? "fail" : "pass", "Checked /wp-content/uploads/");

  const leaksFiles = (await Promise.all(["/wp-config.php.bak", "/wp-config.php~", "/wp-config.bak", "/.env", "/.git/HEAD", "/wp-content/debug.log", "/error_log"].map(async (p) => {
    const r = await get(origin + p);
    return r && r.status === 200 && r.text.length > 0 && !/<html/i.test(r.text.slice(0, 300)) ? p : "";
  }))).filter(Boolean);
  add("Security", "exposed-files", "No config backups, logs or .git exposed", leaksFiles.length ? "fail" : "pass", leaksFiles.length ? `Public: ${leaksFiles.join(", ")}` : "None found");

  if (wp) {
    add("Security", "mu-security", "Security mu-plugin installed", wp.mu.security ? "pass" : "fail", wp.mu.security ? "studio-security.php" : "Run the go-live kit");
    add("Security", "admin-email", "Admin email is the agency's address", !adminEmail ? "todo" : wp.admin_email.toLowerCase() === adminEmail.toLowerCase() && wp.mu.admin ? "pass" : "fail",
      !adminEmail ? "Set the agency admin email in Settings → Integrations" : `${wp.admin_email}${wp.mu.admin ? " (pinned)" : " (not pinned yet)"}`);
    const dup = Object.entries(wp.jobs).filter(([, v]) => v.length > 1);
    add("Security", "one-per-job", "One plugin per job (SEO, forms, cache, backup, SMTP, security)", dup.length ? "fail" : "pass", dup.length ? dup.map(([k, v]) => `${k}: ${v.join(" + ")}`).join("; ") : Object.entries(wp.jobs).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v[0]}`).join(", ") || "No overlaps");
    const cacheOk = !wp.jobs.cache.includes("LiteSpeed Cache") || wp.litespeed;
    add("Security", "cache-server", "Cache plugin matches the server", cacheOk ? "pass" : "fail", cacheOk ? wp.jobs.cache[0] ?? "No cache plugin (host cache)" : "LiteSpeed Cache is active on a server that isn't LiteSpeed");
  }

  /* ---- SEO ---- */
  const counts = (h: string) => ({
    canonical: (h.match(/<link[^>]+rel=["']canonical["']/gi) ?? []).length,
    desc: (h.match(/<meta[^>]+name=["']description["']/gi) ?? []).length,
    og: (h.match(/<meta[^>]+property=["']og:title["']/gi) ?? []).length,
  });
  const c = counts(html);
  const dupTags = c.canonical > 1 || c.desc > 1 || c.og > 1;
  add("SEO", "dup-tags", "One source for meta tags (no duplicates)", dupTags ? "fail" : "pass", dupTags ? `Homepage has ${c.canonical} canonical, ${c.desc} description, ${c.og} og:title tags: two plugins are printing them` : "Single set of tags");

  const types = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].flatMap((m) => [...m[1].matchAll(/"@type"\s*:\s*"(Organization|LocalBusiness|WebSite|[A-Za-z]*Business|Restaurant|Bakery|Store)"/g)].map((t) => t[1]));
  const dupTypes = [...new Set(types.filter((t, i) => types.indexOf(t) !== i))];
  add("SEO", "dup-schema", "Business schema printed once", dupTypes.length ? "fail" : "pass", dupTypes.length ? `Repeated: ${dupTypes.join(", ")}` : types.length ? `${[...new Set(types)].join(", ")}` : "No business schema on the homepage");

  const archives = await archiveUrls(origin, 4);
  if (archives.length) {
    const bad: string[] = [];
    for (const a of archives) {
      const r = await get(a);
      const can = /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(r?.text ?? "")?.[1] ?? /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i.exec(r?.text ?? "")?.[1];
      if (!can || new URL(can, a).href.replace(/\/$/, "") !== a.replace(/\/$/, "")) bad.push(new URL(a).pathname);
    }
    add("SEO", "archive-canonical", "Archives (categories, tags) have a self canonical", bad.length ? "fail" : "pass", bad.length ? `Missing or wrong: ${bad.join(", ")}` : `${archives.length} archives checked`);
  } else add("SEO", "archive-canonical", "Archives (categories, tags) have a self canonical", "info", "No archive sitemaps found");

  const robots = await get(origin + "/robots.txt");
  const blocked = /^\s*Disallow:\s*\/\s*$/im.test(robots?.text ?? "") && /User-agent:\s*\*/i.test(robots?.text ?? "");
  const noindex = /noindex/i.test(home?.headers.get("x-robots-tag") ?? "") || /<meta[^>]+name=["']robots["'][^>]+noindex/i.test(html);
  add("SEO", "indexable", "Search engines allowed (no noindex, robots.txt open)", blocked || noindex || wp?.blog_public === false ? "fail" : "pass",
    [blocked && "robots.txt blocks everything", noindex && "homepage is noindex", wp?.blog_public === false && "“Discourage search engines” is ticked"].filter(Boolean).join("; ") || "Indexable");

  const llms = await get(origin + "/llms.txt");
  add("SEO", "llms", "llms.txt published", llms?.status === 200 && /^#\s/m.test(llms.text) ? "pass" : "warn", llms?.status === 200 ? "Found" : "Missing (optional, helps AI search)");

  if (wp) {
    const icon = wp.site_icon;
    add("SEO", "favicon-size", "Site icon at least 512×512", !icon ? "fail" : icon.width >= 512 && icon.height >= 512 ? "pass" : "warn", !icon ? "No site icon set (Appearance → Customize → Site Identity)" : `${icon.width}×${icon.height}`);
    add("SEO", "webp-serve", "WebP served automatically", wp.webp.rules && wp.webp.uploads ? "pass" : wp.webp.server_can ? "fail" : "warn", wp.webp.rules && wp.webp.uploads ? "Rewrite rules and WebP on upload" : wp.webp.server_can ? "Run the go-live kit (WebP)" : "This server's image library can't write WebP");
  }
  add("SEO", "gsc", "Sitemap submitted in Google Search Console", rec.gsc.sitemapSubmittedAt ? "pass" : "todo", rec.gsc.sitemapSubmittedAt ? `Submitted ${rec.gsc.sitemapSubmittedAt.slice(0, 10)}` : "Verify the property and submit the sitemap, then tick it off");

  /* ---- Privacy ---- */
  try {
    const ck = await cookieAudit(origin + "/");
    add("Privacy", "cookies-before-consent", "No tracking cookies before consent", ck.trackers.length ? "fail" : "pass", ck.trackers.length ? `Set on first load: ${ck.trackers.join(", ")}` : `${ck.cookies.length} cookies on first load, none for tracking`);
    add("Privacy", "consent", "Cookie consent where tracking is used", ck.trackerScripts || ck.trackers.length ? (ck.cmp ? "pass" : "fail") : "pass", ck.trackerScripts || ck.trackers.length ? (ck.cmp ? "Consent tool found" : "Analytics or pixels load with no consent tool") : "No tracking scripts, no banner needed");
    add("Privacy", "privacy-link", "Privacy policy linked from the site", ck.privacyLink ? "pass" : "fail", ck.privacyLink ? "Linked" : "No link containing “privacy” on the homepage");
  } catch (e) {
    add("Privacy", "cookies-before-consent", "No tracking cookies before consent", "todo", `Couldn't open a browser: ${(e as Error).message.slice(0, 100)}`);
  }

  /* ---- Hosting & DNS ---- */
  const liveOrigin = `https://${domain}`;
  const [rootTls, wwwTls] = await Promise.all([tlsCheck(domain), tlsCheck(`www.${domain}`)]);
  add("Hosting & DNS", "ssl-root", `SSL valid on ${domain}`, rootTls.ok ? (rootTls.daysLeft !== undefined && rootTls.daysLeft < 14 ? "warn" : "pass") : "fail", rootTls.detail);
  add("Hosting & DNS", "ssl-www", `SSL valid on www.${domain}`, wwwTls.ok ? "pass" : "fail", wwwTls.detail);

  const [fromHttp, fromWww] = await Promise.all([follow(`http://${domain}/`), follow(`https://www.${domain}/`)]);
  const finalHosts = [fromHttp, fromWww].map((f) => (f.chain.length ? new URL(f.chain[f.chain.length - 1].url).host : ""));
  const oneHome = finalHosts[0] && finalHosts[0] === finalHosts[1] && fromHttp.chain.slice(0, -1).every((c) => c.status === 301 || c.status === 308);
  add("Hosting & DNS", "one-home", "http and www redirect (301) to one address", oneHome ? "pass" : "fail", oneHome ? `Everything ends at https://${finalHosts[0]}` : `http → ${finalHosts[0] || "?"}, www → ${finalHosts[1] || "?"} (${fromHttp.chain.map((c) => c.status).join("→")})`);

  const ns = await lookup(domain, "NS");
  add("Hosting & DNS", "dns-provider", "DNS is hosted and answering", ns.length ? "info" : "fail", ns.length ? `Nameservers: ${ns.join(", ")} (records are changed there)` : "No NS records found");

  const serving = await get(`${liveOrigin}/wp-json/`);
  const isNew = serving?.status === 200 && /studio\\?\/v1/.test(serving.text);
  const ips = await addresses(domain);
  add("Hosting & DNS", "new-host", "The domain serves the new site", isNew ? "pass" : rec.liveAt ? "fail" : "todo",
    isNew ? `${domain} answers from the new WordPress (connector found)${rec.hosting.newIp && ips.includes(rec.hosting.newIp) ? `, A → ${rec.hosting.newIp}` : ""}` : `${domain} → ${ips.join(", ") || "no address"}: still the old site${rec.liveAt ? "" : " (expected before cutover)"}`);

  add("Hosting & DNS", "hosting-owner", "Hosting account is the client's own", rec.hosting.clientOwns ? "pass" : "todo", rec.hosting.clientOwns ? `${rec.hosting.provider || "Host"}${rec.hosting.account ? ` · ${rec.hosting.account}` : ""}` : "Confirm the client owns the hosting account");

  const dom = await domainInfo(domain);
  add("Hosting & DNS", "domain-expiry", "Domain renews for at least 60 days", !dom ? "info" : dom.daysLeft >= 60 ? "pass" : dom.daysLeft >= 30 ? "warn" : "fail", dom ? `${dom.registrar || "Registrar unknown"} · expires ${dom.expires.slice(0, 10)} (${dom.daysLeft} days)` : "Registry didn't say (RDAP)");

  if (rec.dns.snapshotAt || (await addresses(`old.${domain}`)).length) {
    const old = await follow(`http://old.${domain}/`);
    const ok = old.final && old.final.status < 400;
    add("Hosting & DNS", "old-subdomain", `old.${domain} loads the old site`, ok ? "pass" : "warn", ok ? `Status ${old.final!.status}` : "Not loading: add old." + domain + " as an alias on the old host");
  }

  /* ---- Email ---- */
  const mx = await mxHosts(domain);
  const mailNames = [...new Set([`mail.${domain}`, ...mx.filter((m) => m.endsWith(domain))])];
  const proxied: string[] = [];
  for (const n of mailNames) for (const ip of await addresses(n)) if (await isCloudflareIp(ip)) proxied.push(n);
  add("Email", "mail-dns-only", "Mail hostnames point straight at the mail server", proxied.length ? "fail" : "pass", proxied.length ? `Behind a web proxy: ${[...new Set(proxied)].join(", ")}. Mail apps can't connect through it: point these records directly at the mail server (in Cloudflare, “DNS only”).` : mx.length ? `MX: ${mx.join(", ")}` : "No MX records");
  add("Email", "mx", "MX records present", mx.length ? "pass" : "fail", mx.length ? mx.join(", ") : "No MX: the domain can't receive mail");

  const txt = await lookup(domain, "TXT");
  const spf = txt.filter((t) => /^v=spf1/i.test(t));
  const spfLookups = spf[0] ? (spf[0].match(/\b(include:|a\b|a:|mx\b|mx:|ptr|exists:|redirect=)/gi) ?? []).length : 0;
  add("Email", "spf", "SPF record (one, ends in ~all or -all)",
    spf.length !== 1 ? "fail" : /[+?]all\b/i.test(spf[0]) || !/[~-]all\b|redirect=/i.test(spf[0]) ? "fail" : spfLookups > 10 ? "fail" : "pass",
    spf.length === 0 ? "No SPF record" : spf.length > 1 ? `${spf.length} SPF records: merge them into one` : `${spf[0]}${spfLookups > 10 ? ` (more than 10 lookups)` : ""}`);

  const dkim: string[] = [];
  await Promise.all(DKIM_SELECTORS.map(async (sel) => {
    const [t, cn] = await Promise.all([lookup(`${sel}._domainkey.${domain}`, "TXT"), lookup(`${sel}._domainkey.${domain}`, "CNAME")]);
    if (t.some((x) => /v=DKIM1|k=rsa|p=/i.test(x)) || cn.length) dkim.push(sel);
  }));
  add("Email", "dkim", "DKIM signing key published", dkim.length ? "pass" : "warn", dkim.length ? `Selector: ${dkim.join(", ")}` : "No key under common selectors: the delivery test confirms it either way");

  const dmarc = (await lookup(`_dmarc.${domain}`, "TXT")).find((t) => /^v=DMARC1/i.test(t));
  const policy = /\bp=(\w+)/i.exec(dmarc ?? "")?.[1]?.toLowerCase();
  add("Email", "dmarc", "DMARC record", !dmarc ? "fail" : policy === "none" ? "warn" : "pass", dmarc ? `${dmarc}${policy === "none" ? " (monitoring only; move to quarantine once reports are clean)" : ""}` : `No _dmarc.${domain} record`);

  // Clients connect to mail.<domain> or an MX inside the domain; with neither, mail is the provider's (Google, Hostinger…).
  const own = mx.find((m) => m.endsWith(domain)) ?? ((await addresses(`mail.${domain}`)).length ? `mail.${domain}` : "");
  if (!own) add("Email", "mail-tls", "Mail clients can connect over TLS", mx.length ? "pass" : "info", mx.length ? `Mail is hosted by ${mx[0].split(".").slice(-2).join(".")}; clients connect to the provider's own servers` : "No mail on this domain");
  else {
    const [imaps, ssl, starttls] = await Promise.all([tlsCheck(own, 993), smtpProbe(own, 465, "ssl"), smtpProbe(own, 587, "tls")]);
    const smtpOk = ssl.ok || starttls.ok;
    add("Email", "mail-tls", "Mail clients can connect directly (IMAP and SMTP over TLS)", imaps.ok && smtpOk ? "pass" : imaps.ok || smtpOk ? "warn" : "fail", `IMAP ${imaps.detail} · SMTP ${ssl.detail} · ${starttls.detail}`);
  }

  if (wp) {
    const conn = wp.smtp.connections.find((x) => x.default) ?? wp.smtp.connections[0];
    add("Email", "smtp", "Site mail goes through authenticated SMTP", conn ? (conn.from.toLowerCase().endsWith("@" + domain) || conn.from.toLowerCase().endsWith("." + domain) ? "pass" : "warn") : "fail",
      conn ? `FluentSMTP: ${conn.from} via ${conn.host || conn.provider}${conn.from.toLowerCase().endsWith(domain) ? "" : " (not the client's own domain)"}` : wp.jobs.smtp.length ? `${wp.jobs.smtp[0]} is active; set it up in FluentSMTP for the delivery check` : "PHP mail(): lands in spam or disappears");
  }
  const mt = rec.mailTest;
  add("Email", "delivery", "Form mail reaches an outside inbox with SPF pass", !mt ? "todo" : mt.received && mt.spf === "pass" ? (mt.dkim === "pass" ? "pass" : "warn") : mt.received === null && mt.sent ? "warn" : "fail",
    !mt ? "Run the delivery test" : mt.detail);

  /* ---- Redirects ---- */
  if (rec.redirects.length) {
    const bad: string[] = [];
    let checked = 0;
    for (const r of rec.redirects.slice(0, 60)) {
      const res = await get(new URL(r.from, liveOrigin).href);
      checked++;
      const to = res?.location ? new URL(res.location, liveOrigin) : null;
      const want = new URL(r.to, liveOrigin);
      r.status = res?.status ?? "no answer";
      if (!(res && (res.status === 301 || res.status === 308) && to && to.pathname.replace(/\/$/, "") === want.pathname.replace(/\/$/, ""))) bad.push(`${r.from} (${r.status})`);
    }
    add("Redirects", "old-urls", "Old URLs redirect (301) to their new page", bad.length ? (rec.liveAt ? "fail" : "todo") : "pass", bad.length ? `${bad.length} of ${checked} not redirecting yet: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? "…" : ""}` : `${checked} redirects answer 301`);
  } else add("Redirects", "old-urls", "Old URLs redirect (301) to their new page", rec.oldSiteUrl ? "todo" : "info", rec.oldSiteUrl ? "Build the redirect map" : "No old site recorded");

  /* ---- Backups ---- */
  if (wp) {
    const u = wp.updraft;
    add("Backups", "backup-plugin", "UpdraftPlus active and scheduled", !u.active ? "fail" : u.files === "manual" || u.db === "manual" ? "fail" : "pass", u.active ? `Files ${u.files}, database ${u.db}` : "Not installed");
    add("Backups", "backup-remote", "Backups stored off the server", u.remote.length ? "pass" : "fail", u.remote.length ? u.remote.join(", ") : "No remote storage: a server failure takes the backups with it");
    const age = u.last ? (Date.now() - new Date(u.last.at).getTime()) / 86400000 : Infinity;
    add("Backups", "backup-last", "A complete backup finished in the last 8 days", u.last?.success && age <= 8 ? "pass" : "fail", u.last ? `${u.last.at.slice(0, 16).replace("T", " ")} · ${u.last.success ? "complete" : `${u.last.errors} errors`}` : "No backup yet");
  }
  add("Backups", "restore-test", "A restore has been tested", rec.restoreTest ? "pass" : "todo", rec.restoreTest ? `${rec.restoreTest.at.slice(0, 10)}${rec.restoreTest.note ? ` · ${rec.restoreTest.note}` : ""}` : "Restore a backup to staging once and record it");

  return out;
}
