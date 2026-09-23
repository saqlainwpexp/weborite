import type { Page } from "playwright";
import { newContext } from "../pipeline/browser.ts";

export interface MapsPlace {
  placeId: string;
  name: string;
  category: string;
  phone: string;
  website: string;
  address: string;
  rating: number | null;
  reviews: number | null;
  mapsUrl: string;
}

const pause = (min: number, max: number) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

/** Decline Google's consent screen when it appears (EU). */
export async function passConsent(page: Page) {
  if (!/consent\.google/.test(page.url())) {
    const btn = page.getByRole("button", { name: /reject all/i }).first();
    if (!(await btn.isVisible().catch(() => false))) return;
  }
  const reject = page.getByRole("button", { name: /reject all|alles afwijzen/i }).first();
  await reject.click({ timeout: 5000 }).catch(() => {});
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(1500);
}

function cleanWebsite(href: string) {
  if (!href) return "";
  try {
    const u = new URL(href);
    // Google sometimes wraps the site in a redirect.
    if (u.hostname.endsWith("google.com") && u.searchParams.get("q")) return cleanWebsite(u.searchParams.get("q")!);
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^gclid$|^fbclid$/i.test(k)) u.searchParams.delete(k);
    u.hash = "";
    return u.toString().replace(/\?$/, "");
  } catch {
    return href;
  }
}

function placeIdFrom(url: string) {
  return url.match(/!19s(ChIJ[\w-]+)/)?.[1] ?? url.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i)?.[1] ?? url;
}

async function collectLinks(page: Page, max: number, onProgress: (n: number) => void) {
  const feed = page.locator('div[role="feed"]');
  const seen = new Map<string, string>();
  let stale = 0;
  for (let round = 0; round < 40 && seen.size < max; round++) {
    const links = await page.$$eval('div[role="feed"] a[href*="/maps/place/"]', (as) => as.map((a) => (a as HTMLAnchorElement).href));
    const before = seen.size;
    for (const href of links) {
      const id = placeIdFrom(href);
      if (!seen.has(id)) seen.set(id, href);
    }
    onProgress(Math.min(seen.size, max));
    const ended = await page.getByText(/reached the end of the list/i).isVisible().catch(() => false);
    if (ended) break;
    stale = seen.size === before ? stale + 1 : 0;
    if (stale >= 3) break;
    await feed.evaluate((el) => el.scrollBy(0, el.scrollHeight)).catch(() => {});
    await pause(1200, 1900);
  }
  return [...seen.values()].slice(0, max);
}

async function readPlace(page: Page, url: string): Promise<MapsPlace | null> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector("h1", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(900);
  const d = await page.evaluate(() => {
    const txt = (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? "";
    const attr = (sel: string, a: string) => document.querySelector(sel)?.getAttribute(a) ?? "";
    const reviewsLabel = Array.from(document.querySelectorAll("[aria-label]"))
      .map((e) => e.getAttribute("aria-label") || "")
      .find((l) => /^[\d.,\s]+reviews?$/i.test(l.trim()));
    return {
      name: txt("h1"),
      summary: txt("div.F7nice"),
      reviewsLabel: reviewsLabel ?? "",
      category: txt("button.DkEaL"),
      phoneId: attr('button[data-item-id^="phone:tel:"]', "data-item-id"),
      phoneLabel: attr('button[data-item-id^="phone:tel:"]', "aria-label"),
      website: (document.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement | null)?.href ?? "",
      address: attr('button[data-item-id="address"]', "aria-label"),
    };
  });
  if (!d.name) return null;

  const ratingMatch = d.summary.match(/^\s*([\d.,]+)/);
  const reviewsMatch = d.summary.match(/\(([\d.,\s]+)\)/) ?? d.reviewsLabel.match(/([\d.,\s]+)/);
  const toInt = (s?: string) => (s ? Number(s.replace(/[^\d]/g, "")) : NaN);
  const reviews = toInt(reviewsMatch?.[1]);
  const rating = ratingMatch ? Number(ratingMatch[1].replace(",", ".")) : NaN;
  const phone = d.phoneId.replace(/^phone:tel:/, "") || d.phoneLabel.replace(/^Phone:\s*/i, "").trim();

  return {
    placeId: placeIdFrom(page.url()) || placeIdFrom(url),
    name: d.name,
    category: d.category,
    phone,
    website: cleanWebsite(d.website),
    address: d.address.replace(/^Address:\s*/i, "").trim(),
    rating: Number.isFinite(rating) ? rating : null,
    reviews: Number.isFinite(reviews) ? reviews : null,
    mapsUrl: url.split("?")[0],
  };
}

/** Search Google Maps and stream each place back as soon as it's read. */
export async function searchMaps(
  query: string,
  max: number,
  hooks: { onLinks: (n: number) => void; onPlace: (p: MapsPlace) => void; shouldStop: () => boolean },
) {
  const ctx = await newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await passConsent(page);
    const hasFeed = await page.waitForSelector('div[role="feed"]', { timeout: 20000 }).then(() => true).catch(() => false);

    let links: string[];
    if (hasFeed) links = await collectLinks(page, max, hooks.onLinks);
    else if (/\/maps\/place\//.test(page.url())) links = [page.url()]; // query matched a single place
    else throw new Error("Google Maps returned no results for this search");

    for (const href of links) {
      if (hooks.shouldStop()) break;
      const place = await readPlace(page, href).catch(() => null);
      if (place) hooks.onPlace(place);
      await pause(700, 1400);
    }
    return links.length;
  } finally {
    await ctx.close();
  }
}
