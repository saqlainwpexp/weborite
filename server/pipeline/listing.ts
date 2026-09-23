import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { leadDir, writeJson } from "../db.ts";
import type { Asset, Capture, Fact, Prospect } from "../../shared/types.ts";
import { passConsent } from "../finder/maps.ts";
import { MOBILE, UA_MOBILE, newContext } from "./browser.ts";
import type { CaptureOutput } from "./capture.ts";

/**
 * "Design from scratch" capture for a business with no website: everything comes from its
 * Google Maps listing (details, hours, description, review snippets, the listing's own photos).
 * Every fact is kept verbatim so the no-invented-facts gate still applies.
 */
export async function captureListing(leadId: string, p: Prospect): Promise<CaptureOutput> {
  const dir = leadDir(leadId);
  const assetsDir = join(dir, "assets");
  rmSync(assetsDir, { recursive: true, force: true });
  mkdirSync(assetsDir, { recursive: true });
  const src = p.mapsUrl;
  const facts: Fact[] = [];
  const fact = (text: string) => text.trim() && facts.push({ text: text.trim(), sourceUrl: src });

  // What Lead Finder already verified.
  fact(p.name);
  if (p.category) fact(p.category);
  if (p.address) fact(p.address);
  if (p.phone) fact(p.phone);
  if (p.emails[0]) fact(p.emails[0]);
  if (p.rating != null) fact(`${p.rating.toFixed(1)} stars on Google`);
  if (p.reviews != null) fact(`${p.reviews} Google reviews`);

  const assets: Asset[] = [];
  let description = p.category;
  const ctx = await newContext({ locale: "en-US", viewport: { width: 1440, height: 900 } });
  try {
    const page = await ctx.newPage();
    await page.goto(src.includes("hl=") ? src : `${src}${src.includes("?") ? "&" : "?"}hl=en`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await passConsent(page);
    await page.waitForSelector("h1", { timeout: 20000 }).catch(() => {});
    // The cover photo arrives a moment after the text.
    await page.waitForFunction(() => Array.from(document.images).some((i) => /googleusercontent/.test(i.src) && i.naturalWidth > 150), null, { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(dir, "desktop-fold.jpg"), type: "jpeg", quality: 78 });
    await page.screenshot({ path: join(dir, "desktop.jpg"), type: "jpeg", quality: 78 });
    // Open the hours dropdown so the whole week is in the page, not just today.
    await page.locator('[data-item-id="oh"], [aria-label*="hours" i][aria-expanded="false"]').first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(700);
    // Scroll the side panel so the photo strip and review cards load. Google shows fewer of both
    // (a "limited view") to visitors it doesn't recognise, so these are a bonus, not a given.
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => {
        const panel = Array.from(document.querySelectorAll<HTMLElement>('div[role="main"] *')).find((e) => e.scrollHeight > e.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(e).overflowY));
        panel?.scrollBy(0, 700);
      });
      await page.waitForTimeout(600);
    }

    const info = await page.evaluate(() => {
      const t = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
      const labels = Array.from(document.querySelectorAll("[aria-label]")).map((e) => e.getAttribute("aria-label") ?? "");
      // The week's hours sit in a (collapsed) table: "Monday | 12–10 PM".
      const days = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i;
      const hours = Array.from(document.querySelectorAll("table tr"))
        .map((tr) => Array.from(tr.querySelectorAll("td, th")).map(t).filter(Boolean))
        .filter((c) => c.length >= 2 && days.test(c[0]))
        .map((c) => `${c[0].replace(/\s*\(.*\)$/, "")}: ${c[1].replace(/Copy open hours|Hide open hours.*/i, "").trim()}`)
        .join("; ");
      // The short "About" blurb and attribute chips on the overview.
      const about = Array.from(document.querySelectorAll('div[role="main"] div')).map(t).find((x) => x.length > 60 && x.length < 400 && /[.!]$/.test(x) && !/review|photo|directions/i.test(x.slice(0, 20))) ?? "";
      // Review cards on the overview: the longest text block in each is the review itself.
      const quotes = [...new Set(Array.from(document.querySelectorAll("[data-review-id]")).map((card) => {
        // The review body is the longest text node without child elements (not the header with stars and dates).
        const leaves = Array.from(card.querySelectorAll("span, div")).filter((e) => !Array.from(e.children).some((c) => c.tagName !== "BR"));
        const body = leaves.map(t).filter((x) => x.length > 25 && !/\b(ago|reviews?|photos?|local guide)\b/i.test(x.slice(0, 40))).sort((x, y) => y.length - x.length)[0] ?? "";
        return body.replace(/\s*…?\s*More$/, "").replace(/[\u2605\u2606\ue000-\uf8ff]/g, "").trim().slice(0, 280);
      }).filter((x) => x.length > 25))].slice(0, 6).map((x) => `“${x}”`);
      const service = labels.filter((l) => /^(service options|offers|amenities|highlights|accessibility)/i.test(l)).slice(0, 6);
      // Photos: the listing's own images (<img> and background images). Reviewer avatars (/a/, /a-/) are skipped.
      const isPhoto = (u: string) => /googleusercontent\.com\/(gps-cs|gps-proxy|grass-cs|geougc|p\/)/.test(u) && !/\/a-?\//.test(u);
      const fromImg = Array.from(document.images).filter((i) => isPhoto(i.src) && i.naturalWidth >= 100).map((i) => ({ src: i.src, w: i.naturalWidth, h: i.naturalHeight }));
      const fromBg = Array.from(document.querySelectorAll<HTMLElement>("[style*='googleusercontent']"))
        .map((e) => (e.getAttribute("style") ?? "").match(/url\("?([^")]+)"?\)/)?.[1] ?? "")
        .map((u) => (u.startsWith("//") ? `https:${u}` : u))
        .filter(isPhoto)
        .map((src) => ({ src, w: 200, h: 200 }));
      const imgs = [...fromImg.sort((x, y) => y.w * y.h - x.w * x.h), ...fromBg];
      return { hours, about, quotes, service, imgs };
    });
    if (info.about) {
      description = info.about;
      fact(info.about);
    }
    if (info.hours) fact(`Opening hours: ${info.hours.replace(/ /g, " ")}`);
    for (const q of info.quotes) fact(`Google review: ${q}`);
    for (const s of info.service) fact(s);

    // Ask Google for a larger version of each photo (the URL carries the size).
    const seen = new Set<string>();
    for (const im of info.imgs) {
      const base = im.src.replace(/=[^/]*$/, "");
      if (seen.has(base) || assets.length >= 8) continue;
      seen.add(base);
      try {
        const res = await fetch(`${base}=w1600-h1100-k-no`, { signal: AbortSignal.timeout(20000) });
        const type = res.headers.get("content-type") ?? "";
        if (!res.ok || !/image/.test(type)) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 12000) continue; // icons, avatars
        const name = `assets/photo-${assets.length + 1}.${/png/.test(type) ? "png" : /webp/.test(type) ? "webp" : "jpg"}`;
        writeFileSync(join(dir, name), buf);
        assets.push({ path: name, sourceUrl: src, kind: "image", width: 1600, height: 1100, aboveFold: assets.length === 0, area: im.w * im.h });
      } catch {
        /* skip that photo */
      }
    }
  } catch (e) {
    console.warn(`[listing ${leadId}]`, (e as Error).message);
  } finally {
    await ctx.close();
  }

  // The listing as a phone shows it, for the "today" side of the comparison.
  const m = await newContext({ viewport: MOBILE, userAgent: UA_MOBILE, isMobile: true, hasTouch: true, locale: "en-US" });
  try {
    const page = await m.newPage();
    await page.goto(src, { waitUntil: "domcontentloaded", timeout: 45000 });
    await passConsent(page);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: join(dir, "mobile.jpg"), type: "jpeg", quality: 78 });
  } catch {
    /* no mobile screenshot */
  } finally {
    await m.close();
  }

  const capture: Capture = { url: src, finalUrl: src, title: p.name, description, palette: [], fonts: [], logo: null, assets, capturedAt: new Date().toISOString() };
  writeJson(leadId, "capture.json", capture);
  writeJson(leadId, "facts.json", facts);
  writeJson(leadId, "checks.json", { mobile: [], contrast: [] });
  return { capture, facts, mobile: [], contrast: [] };
}
