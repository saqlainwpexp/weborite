import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { leadDir, writeJson } from "../db.ts";
import type { Capture, Diagnosis, Fact, GateCheck, GateResult } from "../../shared/types.ts";
import { DESKTOP, MOBILE, newContext } from "./browser.ts";
import { mobileChecks, navToggleCheck, runAxeContrast } from "./capture.ts";
import { googleFonts, isGoogleFamily, primaryFamily } from "../fonts.ts";

const PLACEHOLDER = /lorem ipsum|dolor sit amet|placeholder|your company|your business name|example\.com|\bTODO\b|\bTBD\b|\[insert|\{\{|xxx-xxx|555-01\d\d/i;
const STOCK_HOSTS = /unsplash\.com|picsum\.photos|placehold|placekitten|pexels\.com|via\.placeholder|dummyimage|loremflickr/i;

/** Numbers that carry claims: ratings, counts, years, percentages. */
function claimNumbers(text: string) {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d[\d,.]*\d|\d/g)) {
    const n = m[0].replace(/,/g, "").replace(/\.$/, "");
    if (n.length === 1 && !/[★⭐]|\/\s*5|star|rating|review|year/i.test(text.slice(Math.max(0, m.index! - 20), m.index! + 20))) continue;
    out.add(n);
  }
  return out;
}

function hexDist(a: string, b: string) {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

function hsl(h: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  const hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (hue * 60 + 360) % 360, s, l };
}

/** Same brand hue at a different lightness (e.g. a darker red for button contrast). */
function sameHue(a: string, brand: string) {
  const x = hsl(a);
  const y = hsl(brand);
  if (y.s < 0.2 || x.s < y.s * 0.6) return false;
  const dh = Math.min(Math.abs(x.h - y.h), 360 - Math.abs(x.h - y.h));
  return dh <= 8 && x.l > 0.12 && x.l < 0.9;
}

export interface InspectOptions {
  /** Everything the page is allowed to state: scraped site text plus any client-supplied details. */
  facts: string[];
  strongestAsset: Diagnosis["strongestAsset"] | null;
  logo: Capture["logo"];
  brand: Diagnosis["brand"];
}

/** Deterministic quality checks on one rendered page (file:// or http:// URL). */
export async function inspectPage(url: string, input: InspectOptions): Promise<GateCheck[]> {
  const checks: GateCheck[] = [];

  // ---- desktop render ----
  const ctx = await newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(800);

  const dom = await page.evaluate(() => {
    const used = new Set<string>();
    document.querySelectorAll("[class]").forEach((el) => el.classList.forEach((c) => used.add(c)));
    const defined = new Set<string>();
    const walk = (rules: CSSRuleList) => {
      for (const r of Array.from(rules)) {
        if ("selectorText" in r) for (const m of (r as CSSStyleRule).selectorText.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) defined.add(m[1]);
        if ("cssRules" in r) walk((r as CSSGroupingRule).cssRules);
      }
    };
    for (const s of Array.from(document.styleSheets)) {
      try {
        walk(s.cssRules);
      } catch {
        /* cross-origin sheet (Google Fonts) */
      }
    }
    // Classes referenced from inline scripts count as defined behaviour hooks.
    const scripts = Array.from(document.scripts).map((s) => s.textContent || "").join("\n");
    const undefinedClasses = [...used].filter((c) => !defined.has(c) && !scripts.includes(c));

    const refs: string[] = [];
    document.querySelectorAll<HTMLElement>("img, video, source, iframe, link[rel=icon], image").forEach((el) => {
      for (const a of ["src", "srcset", "poster", "href", "data-src"]) {
        const v = el.getAttribute(a);
        if (v) refs.push(v);
      }
    });
    document.querySelectorAll<HTMLElement>("*").forEach((el) => {
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== "none") refs.push(bg);
    });
    const brokenImages = Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.getAttribute("src") || "");

    const colors = new Set<string>();
    const toHex = (c: string) => {
      const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
      return m ? "#" + [m[1], m[2], m[3]].map((v) => Math.round(+v).toString(16).padStart(2, "0")).join("") : null;
    };
    document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
      const s = getComputedStyle(el);
      for (const c of [s.color, s.backgroundColor, s.borderTopColor, s.fill]) {
        const h = toHex(c);
        if (h) colors.add(h);
      }
    });
    const hasSvgLogo = !!document.querySelector("header svg, [class*='logo' i] svg");
    // Real, sizable video/embed elements (so a hero video can't be silently downgraded to a still).
    const videoEls: { srcs: string[]; w: number; h: number }[] = [];
    document.querySelectorAll("video").forEach((v) => {
      const r = v.getBoundingClientRect();
      const srcs = [v.getAttribute("src") || "", v.getAttribute("poster") || "", ...Array.from(v.querySelectorAll("source")).map((s) => s.getAttribute("src") || "")].filter(Boolean);
      videoEls.push({ srcs, w: r.width, h: r.height });
    });
    document.querySelectorAll("iframe").forEach((f) => {
      const r = f.getBoundingClientRect();
      videoEls.push({ srcs: [f.getAttribute("src") || ""], w: r.width, h: r.height });
    });
    return {
      videoEls,
      text: document.body.innerText,
      html: document.documentElement.outerHTML,
      undefinedClasses,
      refs,
      brokenImages,
      colors: [...colors],
      hasSvgLogo,
      hasH1: document.querySelectorAll("h1").length === 1,
      hasMain: !!document.querySelector("main"),
      hasViewport: !!document.querySelector("meta[name=viewport]"),
      fontStacks: [...new Set(Array.from(document.querySelectorAll<HTMLElement>("body *"))
        .filter((el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || "").trim().length > 1))
        .map((el) => getComputedStyle(el).fontFamily))],
      loadsGoogleFonts: !!document.querySelector('link[href*="fonts.googleapis.com"], style') && /fonts\.googleapis\.com/.test(document.documentElement.outerHTML),
    };
  });
  const contrastDesktop = await runAxeContrast(page);
  await ctx.close();

  // ---- mobile render ----
  const mctx = await newContext({ viewport: MOBILE, isMobile: true, hasTouch: true });
  const mpage = await mctx.newPage();
  await mpage.goto(url, { waitUntil: "load", timeout: 30000 });
  await mpage.waitForTimeout(800);
  const contrastMobile = await runAxeContrast(mpage);
  const mobile = [...(await mpage.evaluate(mobileChecks)), await navToggleCheck(mpage)];
  await mctx.close();

  // 1. Contrast
  const contrast = [...contrastDesktop, ...contrastMobile];
  checks.push({
    name: "Contrast (WCAG AA)",
    pass: contrast.length === 0,
    detail: contrast.length ? contrast.slice(0, 5).map((c) => `"${c.text}" ${c.ratio}:1 (${c.fg} on ${c.bg})`).join("; ") : "All text passes at desktop and 375px",
  });

  // 2. CSS classes
  checks.push({
    name: "No undefined CSS classes",
    pass: dom.undefinedClasses.length === 0,
    detail: dom.undefinedClasses.length ? `Used but never styled: ${dom.undefinedClasses.slice(0, 15).join(", ")}` : "Every class is defined",
  });

  // 3. Placeholders, stock images and broken files
  const ph = dom.text.match(PLACEHOLDER)?.[0] ?? dom.html.match(STOCK_HOSTS)?.[0];
  checks.push({
    name: "No placeholder content",
    pass: !ph && dom.brokenImages.length === 0,
    detail: ph ? `Found "${ph}"` : dom.brokenImages.length ? `Broken images: ${dom.brokenImages.join(", ")}` : "No placeholder text, stock URLs or broken images",
  });

  // 4. Facts
  const corpus = input.facts.join(" \n ").replace(/,/g, "");
  // Whole-number match: "10" must not hide inside a zip code like 10014 or a phone number.
  const esc = (n: string) => n.replace(/\./g, "\\.");
  const unverified = [...claimNumbers(dom.text)].filter((n) => !new RegExp(`(?<![\\d.])${esc(n)}(?![\\d]|\\.\\d)`).test(corpus));
  checks.push({
    name: "Every figure traces to the source site",
    pass: unverified.length === 0,
    detail: unverified.length ? `Numbers not found on the original site: ${unverified.slice(0, 12).join(", ")}` : "All numbers appear on the original site",
  });

  // 5. Strongest asset survives
  const sa = input.strongestAsset;
  if (sa) {
    const needle = /^https?:/.test(sa.path) ? (sa.path.match(/(?:embed\/|vimeo\.com\/(?:video\/)?)([\w-]+)/)?.[1] ?? sa.path) : basename(sa.path);
    if (sa.kind === "video") {
      // The live site's hero was a video: it must survive as a real, sizable video/embed, not a still.
      // (A dropped-to-image hero is this project's most costly, and most common, generator failure.)
      const asVideo = dom.videoEls.find((v) => v.w >= 240 && v.h >= 135 && v.srcs.some((s) => s.includes(needle)));
      const asStill = !asVideo && dom.refs.some((r) => r.includes(needle));
      checks.push({
        name: "Hero video kept",
        pass: Boolean(asVideo),
        detail: asVideo
          ? `Hero video ${needle} is embedded and plays (${Math.round(asVideo.w)}×${Math.round(asVideo.h)})`
          : asStill
            ? `Hero video ${needle} was downgraded to a static image — restore it as a <video> or embed`
            : `Hero video ${needle} is missing from the mockup`,
      });
    } else {
      const present = dom.refs.some((r) => r.includes(needle));
      checks.push({
        name: "Strongest asset kept",
        pass: present,
        detail: present ? `${sa.kind} ${needle} is used in the mockup` : `${sa.kind} ${needle} is missing from the mockup`,
      });
    }
  }

  // 6. Brand: logo and palette
  const logo = input.logo;
  const logoOk = logo ? dom.refs.some((r) => r.includes(basename(logo.path))) || (logo.path.endsWith(".svg") && dom.hasSvgLogo) : true;
  const brand = input.brand;
  const exact = dom.colors.find((c) => hexDist(c, brand.primary) < 14);
  // A darker/lighter shade of the same hue is allowed (it's how brand colours are made to pass contrast).
  const shade = exact ? undefined : dom.colors.find((c) => sameHue(c, brand.primary));
  const primaryOk = Boolean(exact || shade);
  checks.push({
    name: "Brand logo and colours kept",
    pass: logoOk && primaryOk,
    detail: [
      logoOk ? "Logo used" : "Original logo file not used",
      exact ? `Primary ${brand.primary} present` : shade ? `Primary ${brand.primary} used as shade ${shade} for contrast` : `Primary ${brand.primary} (or a shade of it) not found in rendered colours`,
    ].join(". "),
  });

  // 7. Fonts: every text family must come from Google Fonts so WordPress/Elementor can load it too.
  const gf = await googleFonts();
  const nonGoogle = [...new Set(dom.fontStacks.map(primaryFamily))].filter((f) => f && !isGoogleFamily(f, gf));
  checks.push({
    name: "Fonts load from Google Fonts",
    pass: nonGoogle.length === 0 && dom.loadsGoogleFonts,
    detail: nonGoogle.length
      ? `Not on Google Fonts: ${nonGoogle.slice(0, 6).join(", ")}. Use the closest Google Fonts family and load it with a <link>.`
      : dom.loadsGoogleFonts ? "Every text family is a Google Font" : "No Google Fonts stylesheet is loaded",
  });

  // 8. Mobile + structure
  const mobileFails = mobile.filter((m) => !m.pass && (m.id === "horizontal-scroll" || m.id === "nav-toggle" || m.id === "overflowing-media"));
  const structure = [!dom.hasViewport && "missing viewport meta", !dom.hasH1 && "needs exactly one <h1>", !dom.hasMain && "missing <main>"].filter(Boolean);
  checks.push({
    name: "Works at 375px, semantic structure",
    pass: mobileFails.length === 0 && structure.length === 0,
    detail: [...mobileFails.map((m) => m.detail), ...structure].join("; ") || "No sideways scroll, nav opens, semantic landmarks present",
  });

  return checks;
}

export async function runGate(leadId: string, input: { capture: Capture; diagnosis: Diagnosis; facts: Fact[] }, attempt: number): Promise<GateResult> {
  const url = pathToFileURL(join(leadDir(leadId), "mockup", "index.html")).href;
  const checks = await inspectPage(url, {
    facts: input.facts.map((f) => f.text),
    strongestAsset: input.diagnosis.strongestAsset,
    logo: input.capture.logo,
    brand: input.diagnosis.brand,
  });
  const result: GateResult = { pass: checks.every((c) => c.pass), attempt, checks };
  writeJson(leadId, "gate.json", result);
  return result;
}
