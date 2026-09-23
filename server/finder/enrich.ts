import { newContext } from "../pipeline/browser.ts";
import { blockPrivateNetwork, isPrivateHost } from "../security.ts";
import type { WhatsappStatus } from "../../shared/types.ts";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const CONTACT_HINT = /contact|kontakt|over-ons|over_ons|\/over\b|about|impressum|imprint|privacy|colofon|algemene|voorwaarden|team/i;
const JUNK_DOMAINS = /(sentry|wixpress|example|domain|email|yourdomain|yoursite|sentry-next|godaddy|schema)\.(com|io|org|net|nl)$/i;
const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|avif|css|js|ico|woff2?)$/i;
const WA_LINK = /(?:wa\.me\/|api\.whatsapp\.com\/send|web\.whatsapp\.com\/send|whatsapp:\/\/send)/i;

async function fetchHtml(url: string): Promise<{ html: string; finalUrl: string } | null> {
  try {
    if (isPrivateHost(new URL(url).hostname)) return null;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.8,nl;q=0.6" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "html")) return null;
    const html = (await res.text()).slice(0, 2_000_000);
    return { html, finalUrl: res.url || url };
  } catch {
    return null;
  }
}

/** Fallback for JS-rendered or bot-protected sites. */
async function renderHtml(url: string): Promise<{ html: string; finalUrl: string } | null> {
  const ctx = await newContext({ userAgent: UA, locale: "en-US" });
  await blockPrivateNetwork(ctx);
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2500);
    return { html: await page.content(), finalUrl: page.url() };
  } catch {
    return null;
  } finally {
    await ctx.close();
  }
}

function decodeCfEmail(hex: string) {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

function decodeEntities(s: string) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

export function extractEmails(html: string): string[] {
  const found = new Set<string>();
  const text = decodeEntities(html)
    .replace(/%40/g, "@")
    .replace(/\s*[[(]\s*(?:at|apenstaartje)\s*[\])]\s*/gi, "@")
    .replace(/\s*[[(]\s*(?:dot|punt)\s*[\])]\s*/gi, ".");
  for (const m of text.matchAll(/data-cfemail="([0-9a-f]+)"/gi)) found.add(decodeCfEmail(m[1]));
  for (const m of text.matchAll(/mailto:([^"'?\s>]+)/gi)) found.add(decodeURIComponent(m[1]));
  for (const m of text.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) found.add(m[0]);
  return [...found]
    .map((e) => e.trim().toLowerCase().replace(/^[^a-z0-9]+|[.]+$/g, ""))
    .filter((e) => /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e))
    .filter((e) => !ASSET_EXT.test(e) && !JUNK_DOMAINS.test(e.split("@")[1]) && !/^(u00|x22|\d+x)/.test(e) && e.length < 80);
}

function contactLinks(html: string, base: string): string[] {
  const host = new URL(base).hostname.replace(/^www\./, "");
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const [href, label] = [m[1], m[2].replace(/<[^>]+>/g, " ")];
    if (!CONTACT_HINT.test(href + " " + label) || /^(mailto|tel|javascript):/i.test(href)) continue;
    try {
      const u = new URL(href, base);
      if (u.hostname.replace(/^www\./, "") === host && !ASSET_EXT.test(u.pathname)) out.add(u.toString().split("#")[0]);
    } catch {
      /* bad href */
    }
  }
  return [...out].sort((a, b) => Number(/contact|kontakt/i.test(b)) - Number(/contact|kontakt/i.test(a))).slice(0, 4);
}

/** Scan the homepage plus up to four contact/about pages for emails and WhatsApp links. */
export async function scanWebsite(website: string) {
  const emails = new Map<string, string>(); // email → page found on
  let waLink = false;
  let home = await fetchHtml(website);
  if (!home || home.html.length < 1500) home = (await renderHtml(website)) ?? home;
  if (!home) return { emails: [] as string[], pages: [] as string[], waLink, note: "Website didn't load" };

  const pages = [home, ...(await Promise.all(contactLinks(home.html, home.finalUrl).map(fetchHtml)))].filter(Boolean) as { html: string; finalUrl: string }[];
  for (const p of pages) {
    if (WA_LINK.test(p.html)) waLink = true;
    for (const e of extractEmails(p.html)) if (!emails.has(e)) emails.set(e, p.finalUrl);
  }
  // Prefer addresses on the business's own domain.
  const domain = new URL(home.finalUrl).hostname.replace(/^www\./, "");
  const sorted = [...emails.entries()].sort((a, b) => Number(b[0].endsWith(domain)) - Number(a[0].endsWith(domain))).slice(0, 5);
  return { emails: sorted.map(([e]) => e), pages: sorted.map(([, p]) => p), waLink, note: `${pages.length} page${pages.length === 1 ? "" : "s"} scanned` };
}

/**
 * wa.me check: for WhatsApp Business accounts the public share page shows the business
 * name as og:title. Other numbers show a generic "Share on WhatsApp" page, which proves nothing.
 */
export async function checkWhatsappBusiness(phoneE164: string): Promise<string | null> {
  const digits = phoneE164.replace(/[^\d]/g, "");
  if (digits.length < 8) return null;
  try {
    const res = await fetch(`https://api.whatsapp.com/send/?phone=${digits}&text&type=phone_number&app_absent=0`, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US" },
      signal: AbortSignal.timeout(15000),
    });
    const html = await res.text();
    const title = decodeEntities(html.match(/<meta property="og:title" content="([^"]*)"/i)?.[1] ?? "").trim();
    if (!title || /^share on whatsapp$/i.test(title)) return null;
    return title;
  } catch {
    return null;
  }
}

export function whatsappStatus(phone: string, businessName: string | null, siteLink: boolean): WhatsappStatus {
  if (businessName) return "business_profile";
  if (siteLink) return "site_link";
  return phone ? "unconfirmed" : "no_phone";
}
