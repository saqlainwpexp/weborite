import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { createHash } from "node:crypto";
import type { Page } from "playwright";
export type { Page };
import { leadDir, writeJson } from "../db.ts";
import type { Asset, Capture, Fact } from "../../shared/types.ts";
import { DESKTOP, MOBILE, UA_DESKTOP, UA_MOBILE, newContext, hideOverlays, settle } from "./browser.ts";
import { assertPublicUrl, blockPrivateNetwork } from "../security.ts";

const MAX_SHOT_HEIGHT = 7000;

interface RawMedia {
  src: string;
  kind: "image" | "video";
  poster?: string;
  w: number;
  h: number;
  top: number;
  area: number;
  alt: string;
}

interface RawPage {
  title: string;
  description: string;
  colors: { hex: string; area: number; role: string }[];
  fonts: { family: string; usage: string }[];
  media: RawMedia[];
  logo: { src: string; w: number; h: number; svg?: string } | null;
  texts: string[];
  links: { href: string; text: string }[];
}

/** Runs inside the page. Collects colours, fonts, media, logo and text. */
function extractPage(): RawPage {
  const toHex = (c: string) => {
    const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    if (m[4] !== undefined && parseFloat(m[4]) < 0.5) return null;
    return "#" + [m[1], m[2], m[3]].map((v) => Math.round(+v).toString(16).padStart(2, "0")).join("");
  };
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && parseFloat(s.opacity) > 0.1;
  };
  const colorMap = new Map<string, { hex: string; area: number; role: string }>();
  const add = (hex: string | null, area: number, role: string) => {
    if (!hex || area <= 0) return;
    const k = hex + role;
    const cur = colorMap.get(k) ?? { hex, area: 0, role };
    cur.area += area;
    colorMap.set(k, cur);
  };
  const all = Array.from(document.querySelectorAll<HTMLElement>("body *")).slice(0, 6000);
  const docTop = (el: Element) => el.getBoundingClientRect().top + window.scrollY;
  for (const el of all) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (docTop(el) > 5000) continue;
    const s = getComputedStyle(el);
    const area = Math.min(r.width, window.innerWidth) * Math.min(r.height, 1200);
    const isButton = el.matches("button, .button, .btn, a[class*='btn' i], a[class*='button' i], input[type=submit]");
    add(toHex(s.backgroundColor), isButton ? area * 8 : area, isButton ? "button" : el.closest("header, nav") ? "header" : "surface");
    if (el.childNodes.length && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim().length > 1)) {
      const len = (el.textContent || "").trim().length;
      add(toHex(s.color), len * parseFloat(s.fontSize), el.matches("a") ? "link" : el.matches("h1,h2,h3") ? "heading" : "text");
    }
  }
  add(toHex(getComputedStyle(document.body).backgroundColor) ?? "#ffffff", 1e6, "page");

  const fontUse = (sel: string, usage: string) => {
    const el = document.querySelector(sel);
    return el ? { family: getComputedStyle(el).fontFamily.split(",")[0].replace(/["']/g, "").trim(), usage } : null;
  };
  const fonts = [fontUse("h1", "h1"), fontUse("h2", "h2"), fontUse("p", "body"), fontUse("nav a, header a", "nav"), fontUse("button, .btn, .button", "button")]
    .filter(Boolean) as { family: string; usage: string }[];

  const media: RawMedia[] = [];
  for (const img of Array.from(document.images)) {
    if (!visible(img)) continue;
    const r = img.getBoundingClientRect();
    const src = img.currentSrc || img.src;
    if (!src || src.startsWith("data:") || r.width < 120 || r.height < 80) continue;
    media.push({ src, kind: "image", w: img.naturalWidth, h: img.naturalHeight, top: docTop(img), area: r.width * r.height, alt: img.alt });
  }
  for (const v of Array.from(document.querySelectorAll("video"))) {
    const r = v.getBoundingClientRect();
    const src = v.currentSrc || v.src || v.querySelector("source")?.getAttribute("src") || "";
    if (!src || r.width < 120) continue;
    media.push({ src: new URL(src, location.href).href, kind: "video", poster: v.poster || undefined, w: v.videoWidth, h: v.videoHeight, top: docTop(v), area: r.width * r.height, alt: "" });
  }
  for (const el of all) {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || !bg.startsWith("url(")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 300 || r.height < 200 || !visible(el)) continue;
    const m = bg.match(/url\(["']?(.*?)["']?\)/);
    if (!m || m[1].startsWith("data:")) continue;
    media.push({ src: new URL(m[1], location.href).href, kind: "image", w: 0, h: 0, top: docTop(el), area: r.width * r.height, alt: "" });
  }
  // Iframe embeds (YouTube/Vimeo heroes) count as video assets.
  for (const f of Array.from(document.querySelectorAll("iframe"))) {
    const r = f.getBoundingClientRect();
    if (r.width < 300 || !/youtube|vimeo/.test(f.src)) continue;
    media.push({ src: f.src, kind: "video", w: r.width, h: r.height, top: docTop(f), area: r.width * r.height, alt: "embed" });
  }

  let logo: RawPage["logo"] = null;
  const logoEl =
    document.querySelector<HTMLElement>("header img[src*='logo' i], header img[alt*='logo' i], header img[class*='logo' i], [class*='logo' i] img, img[src*='logo' i], a[class*='logo' i] img, header .custom-logo") ??
    document.querySelector<HTMLElement>("header a[href='/'] img, header a[href='./'] img, header img");
  if (logoEl instanceof HTMLImageElement) {
    logo = { src: logoEl.currentSrc || logoEl.src, w: logoEl.naturalWidth, h: logoEl.naturalHeight };
  } else {
    const svg = document.querySelector("header [class*='logo' i] svg, header a[href='/'] svg, [class*='logo' i] svg");
    if (svg) logo = { src: "", w: svg.getBoundingClientRect().width, h: svg.getBoundingClientRect().height, svg: svg.outerHTML };
  }

  const texts: string[] = [];
  const seen = new Set<string>();
  for (const el of Array.from(document.querySelectorAll("h1,h2,h3,h4,p,li,blockquote,figcaption,td,dt,dd,span,strong,a,button,address"))) {
    if (!visible(el)) continue;
    if (el.querySelector("p,li,h1,h2,h3,h4,div")) continue;
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (t.length < 2 || t.length > 600 || seen.has(t)) continue;
    seen.add(t);
    texts.push(t);
  }
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("header a, nav a"))
    .map((a) => ({ href: a.href, text: (a.textContent || "").trim() }))
    .filter((l) => l.href.startsWith(location.origin) && l.text);

  return {
    title: document.title,
    description: document.querySelector<HTMLMetaElement>("meta[name=description]")?.content ?? "",
    colors: Array.from(colorMap.values()),
    fonts,
    media,
    logo,
    texts,
    links,
  };
}

/** Runs inside the page at 375px. Finds broken mobile behaviour. */
export async function mobileChecks() {
  const res: { id: string; pass: boolean; detail: string }[] = [];
  const vw = window.innerWidth;
  const sw = document.documentElement.scrollWidth;
  res.push({ id: "horizontal-scroll", pass: sw <= vw + 2, detail: `Page is ${sw}px wide in a ${vw}px viewport` });

  const fixed = Array.from(document.querySelectorAll<HTMLElement>("body *")).filter((el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return (s.position === "fixed" || s.position === "sticky") && r.height > 0 && r.width > vw * 0.5 && s.display !== "none" && s.visibility !== "hidden";
  });
  const covered = fixed.reduce((sum, el) => sum + Math.min(el.getBoundingClientRect().height, window.innerHeight), 0);
  res.push({ id: "fixed-overlap", pass: covered < window.innerHeight * 0.3, detail: `Fixed or sticky elements cover ${Math.round((covered / window.innerHeight) * 100)}% of the screen` });

  const small = Array.from(document.querySelectorAll<HTMLElement>("p, li, a, span")).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && el.childElementCount === 0 && (el.textContent || "").trim().length > 20 && parseFloat(getComputedStyle(el).fontSize) < 13;
  }).length;
  res.push({ id: "small-text", pass: small < 5, detail: `${small} text blocks are smaller than 13px` });

  const taps = Array.from(document.querySelectorAll<HTMLElement>("a, button")).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.top < 3000 && (r.height < 32 || r.width < 32) && (el.textContent || "").trim().length > 0;
  }).length;
  res.push({ id: "tap-targets", pass: taps < 8, detail: `${taps} links or buttons are smaller than 32px` });

  const overflowImgs = Array.from(document.images).filter((i) => i.getBoundingClientRect().right > vw + 4).length;
  res.push({ id: "overflowing-media", pass: overflowImgs === 0, detail: `${overflowImgs} images extend past the screen edge` });

  return res;
}

/** Mark the most likely mobile menu button and count visible nav links (runs in page). */
function findNavToggle() {
  const vw = window.innerWidth;
  const visibleLinks = Array.from(document.querySelectorAll<HTMLElement>("header a, nav a, [role=navigation] a, [class*='menu' i] a")).filter((a) => {
    const r = a.getBoundingClientRect();
    const s = getComputedStyle(a);
    return r.width > 0 && r.height > 0 && r.top >= 0 && r.top < window.innerHeight && r.left < vw && r.right > 0 && s.visibility !== "hidden" && parseFloat(s.opacity) > 0.1;
  }).length;
  const sel = "button[aria-controls], button[aria-expanded], [class*='hamburger' i], [class*='menu-toggle' i], [class*='nav-toggle' i], [class*='burger' i], .navbar-toggler, [aria-label*='menu' i], label[for*='menu' i], label[for*='nav' i]";
  const cands = Array.from(document.querySelectorAll<HTMLElement>(sel))
    .map((el) => el.closest<HTMLElement>("button, a, [role=button], label") ?? el.querySelector<HTMLElement>("button") ?? el)
    .filter((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 8 && r.height > 8 && r.top < 220 && r.top >= 0 && s.visibility !== "hidden";
    });
  document.querySelectorAll("[data-studio-toggle]").forEach((e) => e.removeAttribute("data-studio-toggle"));
  if (cands[0]) cands[0].setAttribute("data-studio-toggle", "1");
  return { visibleLinks, hasToggle: !!cands[0] };
}

/**
 * Mobile header hygiene (runs in the page at 375px): the top bar must hold ONLY the logo and the menu
 * button. Call-to-action buttons belong in a sticky bottom action bar, not crammed into the header.
 * Run AFTER navToggleCheck so the hamburger is tagged with data-studio-toggle and can be excluded.
 */
export function mobileHeaderCheck() {
  const vw = window.innerWidth;
  const header =
    document.querySelector<HTMLElement>("header, [role=banner], [class*='header' i], [class*='navbar' i], [class*='topbar' i]") ||
    Array.from(document.querySelectorAll<HTMLElement>("nav")).find((n) => n.getBoundingClientRect().top < 120) ||
    null;
  if (!header) return { id: "mobile-header", pass: true, detail: "No header bar to check" };

  const CTA = /\b(call|book|quote|contact|get|start|buy|order|schedule|appointment|enquire|inquire|shop|reserve|request|free|today|now|sign ?up|join|subscribe|hire|consult|estimate|demo)\b/i;
  const isToggle = (el: HTMLElement) =>
    el.hasAttribute("data-studio-toggle") || !!el.closest("[data-studio-toggle]") ||
    /hamburger|menu-toggle|nav-toggle|burger|navbar-toggler/i.test(el.className) ||
    el.hasAttribute("aria-controls") || el.hasAttribute("aria-expanded") ||
    /menu|nav/i.test(el.getAttribute("aria-label") || "");
  const isLogo = (el: HTMLElement) =>
    /logo|brand/i.test(el.className) || !!el.querySelector("img, svg") ||
    !!el.closest("[class*='logo' i], [class*='brand' i]");

  const ctas = Array.from(header.querySelectorAll<HTMLElement>("a, button")).filter((el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) < 0.1) return false;
    if (r.top > 160) return false; // the top bar only, not an opened drawer below it
    if (isToggle(el) || isLogo(el)) return false;
    const txt = (el.textContent || "").trim();
    const isTel = (el.getAttribute("href") || "").startsWith("tel:");
    const bg = s.backgroundColor;
    const looksButton = bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent" && parseFloat(s.paddingLeft) > 6;
    return (CTA.test(txt) || isTel || (looksButton && txt.length >= 3));
  }).map((el) => (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30) || (el.getAttribute("href") || "button"));

  // Does a sticky/fixed bottom bar with an action exist (the place CTAs should move to)?
  const hasBottomBar = Array.from(document.querySelectorAll<HTMLElement>("body *")).some((el) => {
    const s = getComputedStyle(el);
    if (s.position !== "fixed" && s.position !== "sticky") return false;
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.bottom >= window.innerHeight - 6 && r.top > window.innerHeight * 0.5 && r.width >= vw * 0.8 && !!el.querySelector("a, button");
  });

  const pass = ctas.length === 0;
  return {
    id: "mobile-header",
    pass,
    detail: pass
      ? (hasBottomBar ? "Mobile header is just the logo and menu; a sticky bottom action bar is present" : "Mobile header is just the logo and menu button")
      : `These must move out of the mobile header into a sticky bottom action bar: ${ctas.slice(0, 5).join(", ")}`,
  };
}

export async function navToggleCheck(page: Page) {
  const before = await page.evaluate(findNavToggle);
  if (!before.hasToggle) {
    return before.visibleLinks >= 2
      ? { id: "nav-toggle", pass: true, detail: `No menu button; ${before.visibleLinks} nav links visible` }
      : { id: "nav-toggle", pass: false, detail: "No visible menu button and no navigation links on mobile" };
  }
  try {
    await page.locator("[data-studio-toggle]").first().click({ timeout: 5000, force: true });
  } catch {
    return { id: "nav-toggle", pass: false, detail: "The menu button can't be tapped" };
  }
  await page.waitForTimeout(1200);
  const after = await page.evaluate(findNavToggle);
  const pass = after.visibleLinks > before.visibleLinks;
  return {
    id: "nav-toggle",
    pass,
    detail: pass ? `Menu opens (${before.visibleLinks} → ${after.visibleLinks} links)` : `Tapping the menu button does not reveal navigation (${before.visibleLinks} → ${after.visibleLinks} visible links)`,
  };
}

function slug(url: string) {
  return createHash("sha1").update(url).digest("hex").slice(0, 10);
}

async function download(page: Page, url: string, dir: string, fallbackExt: string) {
  try {
    const res = await page.context().request.get(url, { timeout: 30000 });
    if (!res.ok()) return null;
    const body = await res.body();
    if (body.length > 60 * 1024 * 1024) return null;
    const type = res.headers()["content-type"] ?? "";
    let ext = extname(new URL(url).pathname).toLowerCase().slice(0, 6);
    if (!/^\.(jpe?g|png|webp|gif|svg|avif|mp4|webm|mov)$/.test(ext)) {
      ext = type.includes("png") ? ".png" : type.includes("webp") ? ".webp" : type.includes("svg") ? ".svg" : type.includes("mp4") ? ".mp4" : type.includes("webm") ? ".webm" : fallbackExt;
    }
    const name = `${slug(url)}${ext}`;
    writeFileSync(join(dir, name), body);
    return `assets/${name}`;
  } catch {
    return null;
  }
}

export interface CaptureOutput {
  capture: Capture;
  facts: Fact[];
  mobile: { id: string; pass: boolean; detail: string }[];
  contrast: { selector: string; ratio: number; fg: string; bg: string; text: string }[];
}

export async function captureSite(leadId: string, url: string): Promise<CaptureOutput> {
  const dir = leadDir(leadId);
  const assetsDir = join(dir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  await assertPublicUrl(url);

  // ---- desktop ----
  const ctx = await newContext({ viewport: DESKTOP, userAgent: UA_DESKTOP, ignoreHTTPSErrors: true });
  await blockPrivateNetwork(ctx);
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch (e) {
    await ctx.close();
    throw new Error(`Could not open ${url}: ${(e as Error).message.split("\n")[0]}`);
  }
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await hideOverlays(page);
  await settle(page);
  await hideOverlays(page);
  const finalUrl = page.url();
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.screenshot({ path: join(dir, "desktop-fold.jpg"), type: "jpeg", quality: 82 });
  await page.screenshot({
    path: join(dir, "desktop.jpg"), type: "jpeg", quality: 78,
    clip: { x: 0, y: 0, width: DESKTOP.width, height: Math.min(height, MAX_SHOT_HEIGHT) }, fullPage: true,
  });

  const raw = await page.evaluate(extractPage);
  const contrast = await runAxeContrast(page);

  // Media: keep the biggest, prefer above-the-fold and video.
  const uniq = new Map<string, RawMedia>();
  for (const m of raw.media) if (!uniq.has(m.src)) uniq.set(m.src, m);
  const ranked = [...uniq.values()]
    .sort((a, b) => (b.kind === "video" ? 1 : 0) - (a.kind === "video" ? 1 : 0) || b.area - a.area)
    .slice(0, 14);
  const assets: Asset[] = [];
  for (const m of ranked) {
    const isEmbed = m.alt === "embed";
    const path = isEmbed ? null : await download(page, m.src, assetsDir, m.kind === "video" ? ".mp4" : ".jpg");
    if (!path && !isEmbed) continue;
    assets.push({
      path: path ?? m.src, sourceUrl: m.src, kind: m.kind,
      width: m.w || undefined, height: m.h || undefined,
      aboveFold: m.top < DESKTOP.height, area: Math.round(m.area),
    });
    if (m.kind === "video" && m.poster) {
      const poster = await download(page, new URL(m.poster, finalUrl).href, assetsDir, ".jpg");
      if (poster) assets.push({ path: poster, sourceUrl: m.poster, kind: "image", aboveFold: m.top < DESKTOP.height, area: 0 });
    }
  }

  let logo: Asset | null = null;
  if (raw.logo?.svg) {
    writeFileSync(join(assetsDir, "logo.svg"), raw.logo.svg.includes("xmlns") ? raw.logo.svg : raw.logo.svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"'));
    logo = { path: "assets/logo.svg", sourceUrl: finalUrl, kind: "logo", width: Math.round(raw.logo.w), height: Math.round(raw.logo.h) };
  } else if (raw.logo?.src) {
    const p = await download(page, raw.logo.src, assetsDir, ".png");
    if (p) logo = { path: p, sourceUrl: raw.logo.src, kind: "logo", width: raw.logo.w, height: raw.logo.h };
  }

  const facts: Fact[] = raw.texts.map((text) => ({ text, sourceUrl: finalUrl }));

  // A few inner pages (about, reviews, services) for real copy and verifiable facts.
  const inner = raw.links
    .sort((a, b) => Number(/about|review|testimonial|service|why|team|story|history|contact|faq|location/i.test(b.href + " " + b.text)) - Number(/about|review|testimonial|service|why|team|story|history|contact|faq|location/i.test(a.href + " " + a.text)))
    .map((l) => l.href.split("#")[0])
    .filter((h, i, a) => h.replace(/\/$/, "") !== finalUrl.replace(/\/$/, "") && a.indexOf(h) === i && !/\.(pdf|jpe?g|png)$/i.test(h))
    .slice(0, 4);
  for (const href of inner) {
    try {
      await page.goto(href, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(800);
      const texts = await page.evaluate(extractPage).then((r) => r.texts);
      for (const text of texts) facts.push({ text, sourceUrl: href });
    } catch {
      /* skip unreachable inner pages */
    }
  }
  await ctx.close();

  // ---- mobile ----
  const mctx = await newContext({ viewport: MOBILE, userAgent: UA_MOBILE, isMobile: true, hasTouch: true, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  await blockPrivateNetwork(mctx);
  const mpage = await mctx.newPage();
  await mpage.goto(finalUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await mpage.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await hideOverlays(mpage);
  await settle(mpage);
  await hideOverlays(mpage);
  const mh = await mpage.evaluate(() => document.documentElement.scrollHeight);
  await mpage.screenshot({
    path: join(dir, "mobile.jpg"), type: "jpeg", quality: 78,
    clip: { x: 0, y: 0, width: MOBILE.width, height: Math.min(mh, MAX_SHOT_HEIGHT) }, fullPage: true,
  });
  const mobile = [...(await mpage.evaluate(mobileChecks)), await navToggleCheck(mpage)];
  await mctx.close();

  const capture: Capture = {
    url,
    finalUrl,
    title: raw.title,
    description: raw.description,
    palette: buildPalette(raw.colors),
    fonts: raw.fonts,
    logo,
    assets,
    capturedAt: new Date().toISOString(),
  };
  writeJson(leadId, "capture.json", capture);
  rmSync(join(dir, "lighthouse.json"), { force: true });
  writeJson(leadId, "facts.json", facts);
  writeJson(leadId, "checks.json", { mobile, contrast });
  return { capture, facts, mobile, contrast };
}

export async function runAxeContrast(page: Page) {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { readFileSync } = await import("node:fs");
  const axeSrc = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  try {
    await page.addScriptTag({ content: axeSrc });
    return await page.evaluate(async () => {
      // @ts-expect-error axe is injected at runtime
      const r = await window.axe.run(document, { runOnly: ["color-contrast"], resultTypes: ["violations"] });
      const out: { selector: string; ratio: number; fg: string; bg: string; text: string }[] = [];
      for (const v of r.violations)
        for (const n of v.nodes.slice(0, 25)) {
          const d = n.any[0]?.data ?? {};
          out.push({ selector: n.target.join(" "), ratio: d.contrastRatio ?? 0, fg: d.fgColor ?? "", bg: d.bgColor ?? "", text: (n.html || "").replace(/<[^>]+>/g, "").trim().slice(0, 60) });
        }
      return out;
    });
  } catch {
    return [];
  }
}

// ---- palette ----
function hexToRgb(h: string) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function dist(a: string, b: string) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}
export function saturation(h: string) {
  const [r, g, b] = hexToRgb(h).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
}

function buildPalette(colors: { hex: string; area: number; role: string }[]): Capture["palette"] {
  const clusters: { hex: string; weight: number; roles: Map<string, number> }[] = [];
  for (const c of colors.sort((a, b) => b.area - a.area)) {
    const hit = clusters.find((k) => dist(k.hex, c.hex) < 22);
    if (hit) {
      hit.weight += c.area;
      hit.roles.set(c.role, (hit.roles.get(c.role) ?? 0) + c.area);
    } else clusters.push({ hex: c.hex, weight: c.area, roles: new Map([[c.role, c.area]]) });
  }
  const total = clusters.reduce((s, c) => s + c.weight, 0) || 1;
  return clusters
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10)
    .map((c) => ({
      hex: c.hex,
      weight: Math.round((c.weight / total) * 1000) / 1000,
      role: [...c.roles.entries()].sort((a, b) => b[1] - a[1])[0][0],
    }));
}
