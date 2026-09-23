import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { newContext } from "../pipeline/browser.ts";
import { extractJson, runClaude } from "../claude/runner.ts";
import type { OnPageResult, SeoImage, SeoPageAudit } from "../../shared/types.ts";
import { UA } from "./crawl.ts";

interface PageExtra {
  text: string;
  blocks: string[];               // FAQ, testimonial, video… detected on the page
  imageContext: Record<string, string>;
}

/** Deterministic on-page audit of every page plus a few site-wide checks. */
export async function auditOnPage(urls: string[], sitemap: string): Promise<{ result: OnPageResult; extra: Record<string, PageExtra> }> {
  const pages: SeoPageAudit[] = [];
  const images = new Map<string, SeoImage>();
  const extra: Record<string, PageExtra> = {};
  const ctx = await newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  try {
    const page = await ctx.newPage();
    for (const url of urls) {
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 40000 });
        await page.evaluate(async () => {
          for (let y = 0; y < document.body.scrollHeight; y += 800) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 50));
          }
        });
      } catch {
        continue;
      }
      const d = await page.evaluate(() => {
        const meta = (sel: string) => document.querySelector<HTMLMetaElement>(sel)?.content ?? "";
        const heads = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((h) => Number(h.tagName[1]));
        let skips = 0;
        for (let i = 1; i < heads.length; i++) if (heads[i] > heads[i - 1] + 1) skips++;
        const schemaTypes: string[] = [];
        for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
          try {
            const j = JSON.parse(s.textContent || "");
            const nodes = Array.isArray(j) ? j : j["@graph"] ?? [j];
            for (const n of nodes) [n["@type"]].flat().forEach((t: string) => t && schemaTypes.push(t));
          } catch {
            schemaTypes.push("(invalid JSON-LD)");
          }
        }
        const text = (document.querySelector("main") ?? document.body).innerText.replace(/\n{2,}/g, "\n").trim();
        const blocks: string[] = [];
        if (document.querySelector("details summary, .elementor-accordion, .elementor-toggle, .e-n-accordion, [itemtype*=FAQPage], .faq")) blocks.push("FAQ / accordion");
        if (document.querySelector(".elementor-testimonial, .testimonial, blockquote")) blocks.push("Testimonials / quotes");
        if (document.querySelector("video, iframe[src*=youtube], iframe[src*=vimeo]")) blocks.push("Video");
        if (document.querySelector("form")) blocks.push("Contact form");
        if (document.querySelector('iframe[src*="google.com/maps"], .elementor-widget-google_maps')) blocks.push("Map");
        if (document.querySelector('[class*="price"], [class*="pricing"]')) blocks.push("Pricing");
        if (document.querySelector('[class*="star"], [class*="rating"]')) blocks.push("Ratings");
        const imgs = Array.from(document.images).filter((i) => i.currentSrc && !i.currentSrc.startsWith("data:") && i.getBoundingClientRect().width > 20).map((i) => {
          const fig = i.closest("figure")?.querySelector("figcaption")?.textContent;
          const near = i.closest("section, article, div")?.querySelector("h1,h2,h3,h4")?.textContent;
          return {
            src: i.currentSrc,
            alt: i.getAttribute("alt"),
            width: i.naturalWidth,
            height: i.naturalHeight,
            renderedWidth: Math.round(i.getBoundingClientRect().width),
            lazy: i.loading === "lazy" || i.hasAttribute("data-src"),
            context: (fig || near || "").replace(/\s+/g, " ").trim().slice(0, 140),
          };
        });
        const origin = location.origin;
        return {
          title: document.title,
          description: meta('meta[name="description"]'),
          canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? "",
          robots: meta('meta[name="robots"]'),
          lang: document.documentElement.lang,
          h1: Array.from(document.querySelectorAll("h1")).map((h) => (h.textContent || "").trim()),
          headingSkips: skips,
          wordCount: text.split(/\s+/).filter(Boolean).length,
          internalLinks: Array.from(document.querySelectorAll("a[href]")).filter((a) => (a as HTMLAnchorElement).href.startsWith(origin)).length,
          og: { title: !!meta('meta[property="og:title"]'), description: !!meta('meta[property="og:description"]'), image: !!meta('meta[property="og:image"]') },
          schemaTypes,
          text: text.slice(0, 9000),
          blocks,
          imgs,
        };
      });
      pages.push({
        url, title: d.title, description: d.description, canonical: d.canonical, robots: d.robots, lang: d.lang,
        h1: d.h1, headingSkips: d.headingSkips, wordCount: d.wordCount, internalLinks: d.internalLinks, og: d.og, schemaTypes: [...new Set(d.schemaTypes)],
      });
      extra[url] = { text: d.text, blocks: d.blocks, imageContext: {} };
      for (const i of d.imgs) {
        extra[url].imageContext[i.src] = i.context;
        if (images.has(i.src)) continue;
        const ext = (i.src.split("?")[0].match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
        images.set(i.src, { src: i.src, page: url, alt: i.alt, bytes: null, format: ext === "jpeg" ? "jpg" : ext || "?", width: i.width, height: i.height, renderedWidth: i.renderedWidth, lazy: i.lazy });
      }
    }
  } finally {
    await ctx.close();
  }

  // Image weights.
  const list = [...images.values()];
  for (let i = 0; i < list.length; i += 8) {
    await Promise.all(list.slice(i, i + 8).map(async (img) => {
      try {
        const r = await fetch(img.src, { method: "HEAD", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
        const len = Number(r.headers.get("content-length"));
        img.bytes = Number.isFinite(len) && len > 0 ? len : null;
        const type = r.headers.get("content-type") ?? "";
        if (/webp/.test(type)) img.format = "webp";
        else if (/avif/.test(type)) img.format = "avif";
      } catch {
        /* leave unknown */
      }
    }));
  }

  // Site-wide basics.
  const origin = new URL(urls[0]).origin;
  const get = (u: string, init: RequestInit = {}) => fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000), ...init }).catch(() => null);
  const robots = await get(origin + "/robots.txt");
  const http = await get(origin.replace(/^https:/, "http:") + "/", { redirect: "manual" });
  const missing = await get(origin + `/studio-qa-${Date.now()}-not-found`);
  const home = await get(origin + "/");
  const homeHtml = home ? await home.text() : "";
  return {
    result: {
      pages,
      images: list,
      site: {
        robotsTxt: Boolean(robots?.ok && /user-agent/i.test(await robots.text())),
        sitemap,
        httpsRedirect: Boolean(http && http.status >= 300 && http.status < 400 && /^https:/.test(http.headers.get("location") ?? "")),
        notFoundStatus: missing?.status ?? 0,
        favicon: /rel=["'](?:shortcut )?icon["']/i.test(homeHtml),
      },
    },
    extra,
  };
}

/* ---------- Claude proposals ---------- */

export async function proposeMeta(siteId: string, cwd: string, pages: SeoPageAudit[], extra: Record<string, PageExtra>, business: string) {
  const res = await runClaude({
    leadId: siteId, task: "seo", cwd,
    system: "You are an SEO copywriter. You write specific, accurate, non-spammy titles and descriptions in the page's own language, using only what the page says.",
    prompt: `Write a meta title and meta description for every page of ${business}.

Rules:
- Title 30–60 characters: the page's topic first, then the brand ("… | ${business}"). Every title must be unique.
- Description 120–155 characters: what the visitor gets on this page, plus a reason to click. Every description must be unique.
- Include the location when the page is local (city or area as written on the page). No keyword stuffing, no all caps, no emojis, and no claims the page doesn't make.

${pages.map((p) => `=== ${p.url}\ncurrent title: ${p.title || "-"}\ncurrent description: ${p.description || "-"}\nH1: ${p.h1.join(" | ") || "-"}\ncontent: ${(extra[p.url]?.text ?? "").slice(0, 1200)}`).join("\n\n")}

Return only JSON:
\`\`\`json
[{"url":"…","title":"…","description":"…"}]
\`\`\``,
  });
  let drafts = extractJson<{ url: string; title: string; description: string }[]>(res.text);
  // Claude counts characters loosely: send out-of-range lines back once to be tightened.
  const inRange = (d: { title: string; description: string }) => d.title.length >= 30 && d.title.length <= 60 && d.description.length >= 70 && d.description.length <= 160;
  const off = drafts.filter((d) => !inRange(d));
  if (off.length) {
    try {
      const fix = await runClaude({
        leadId: siteId, task: "seo", cwd,
        system: "You are an SEO copywriter. You tighten titles and descriptions to exact length limits without changing their meaning.",
        prompt: `These drafts are outside the length limits (title 30–60 characters, description 120–155). Rewrite only what is out of range; keep the brand and location.

${off.map((d) => `=== ${d.url}\ntitle (${d.title.length} chars): ${d.title}\ndescription (${d.description.length} chars): ${d.description}`).join("\n\n")}

Return only JSON:
\`\`\`json
[{"url":"…","title":"…","description":"…"}]
\`\`\``,
      });
      const fixed = new Map(extractJson<{ url: string; title: string; description: string }[]>(fix.text).map((d) => [d.url, d]));
      drafts = drafts.map((d) => {
        const f = fixed.get(d.url);
        if (!f) return d;
        const title = f.title && f.title.length >= 30 && f.title.length <= 60 ? f.title : d.title;
        const description = f.description && f.description.length >= 70 && f.description.length <= 160 ? f.description : d.description;
        return { ...d, title, description };
      });
    } catch {
      /* keep the first drafts; the editor shows character counts */
    }
  }
  return drafts;
}

/** Render each image at most 800px wide to a JPEG so Claude can look at it. */
async function snapshotImages(srcs: string[], dir: string) {
  mkdirSync(dir, { recursive: true });
  const ctx = await newContext({ viewport: { width: 820, height: 820 } });
  const out: Record<string, string> = {};
  try {
    const page = await ctx.newPage();
    for (let i = 0; i < srcs.length; i++) {
      try {
        await page.setContent(`<html><body style="margin:0;background:#fff"><img id="i" src="${srcs[i].replace(/"/g, "&quot;")}" style="max-width:800px;max-height:800px;display:block"></body></html>`, { waitUntil: "load", timeout: 20000 });
        const path = join(dir, `img-${i}.jpg`);
        await page.locator("#i").screenshot({ path, type: "jpeg", quality: 70 });
        out[srcs[i]] = path;
      } catch {
        /* unreachable image: skip */
      }
    }
  } finally {
    await ctx.close();
  }
  return out;
}

const looksAutoNamed = (alt: string) => /^(img|image|dsc|photo|screenshot|untitled|pic)[-_ ]?\d*/i.test(alt) || /\.(jpe?g|png|webp)$/i.test(alt);

export async function proposeAlts(siteId: string, cwd: string, images: SeoImage[], extra: Record<string, PageExtra>) {
  const need = images.filter((i) => i.alt === null || looksAutoNamed(i.alt));
  const shots = await snapshotImages(need.map((i) => i.src), join(cwd, "alt-shots"));
  const results: { src: string; alt: string }[] = [];
  const ready = need.filter((i) => shots[i.src]);
  for (let b = 0; b < ready.length; b += 6) {
    const batch = ready.slice(b, b + 6);
    const res = await runClaude({
      leadId: siteId, task: "seo", cwd, images: batch.map((i) => shots[i.src]),
      system: "You write alt text for accessibility and image SEO. Describe what's actually in the picture, concisely and specifically, in the page's language. Never start with \"image of\" or \"picture of\".",
      prompt: `Write alt text for these ${batch.length} images, which are attached in this order:
${batch.map((i, n) => `${n + 1}. ${i.src}\n   on page: ${i.page}\n   nearby heading/caption: ${extra[i.page]?.imageContext[i.src] || "-"}`).join("\n")}

Rules: under 125 characters, specific (who, what, where, as far as you can see it), with no keyword stuffing. Use "" only for purely decorative images (patterns, dividers, spacer graphics).
Return only JSON: \`\`\`json
[{"src":"…","alt":"…"}]
\`\`\``,
    });
    try {
      results.push(...extractJson<{ src: string; alt: string }[]>(res.text).filter((r) => batch.some((i) => i.src === r.src)));
    } catch {
      /* skip unparseable batch */
    }
  }
  return results.map((r) => ({ src: r.src, alt: r.alt.trim().slice(0, 150) }));
}

const SCHEMA_TYPES = new Set([
  "Organization", "LocalBusiness", "WebSite", "WebPage", "AboutPage", "ContactPage", "FAQPage", "Question", "Answer", "BreadcrumbList", "ListItem",
  "Service", "Offer", "OfferCatalog", "Product", "Review", "Rating", "AggregateRating", "Person", "PostalAddress", "GeoCoordinates",
  "OpeningHoursSpecification", "ImageObject", "VideoObject", "ItemList", "HowTo", "HowToStep", "Place", "ContactPoint", "Brand",
  "Restaurant", "Bakery", "CafeOrCoffeeShop", "FoodEstablishment", "HomeAndConstructionBusiness", "HVACBusiness", "Plumber", "Electrician",
  "ProfessionalService", "Store", "MedicalBusiness", "Dentist", "LegalService", "AutomotiveBusiness", "BeautySalon", "HealthAndBeautyBusiness",
  "SportsActivityLocation", "LodgingBusiness", "RealEstateAgent", "FinancialService", "EducationalOrganization", "Menu", "MenuSection", "MenuItem",
]);

/** Structural + anti-invention checks on generated JSON-LD. */
export function validateSchema(jsonld: unknown, pageText: string, url: string): string[] {
  const errors: string[] = [];
  const obj = jsonld as { "@context"?: string; "@graph"?: Record<string, unknown>[] };
  if (!obj || typeof obj !== "object") return ["Not a JSON object"];
  if (!/schema\.org/.test(String(obj["@context"] ?? ""))) errors.push('@context must be "https://schema.org"');
  const nodes = obj["@graph"] ?? [obj as Record<string, unknown>];
  const text = pageText.replace(/,/g, "").toLowerCase();
  for (const n of nodes) {
    const types = [n["@type"]].flat().map(String);
    for (const t of types) if (!SCHEMA_TYPES.has(t)) errors.push(`Unsupported or misspelled @type "${t}"`);
    if (types.includes("FAQPage")) {
      const qs = (n.mainEntity as { name?: string; acceptedAnswer?: { text?: string } }[] | undefined) ?? [];
      if (!qs.length) errors.push("FAQPage needs mainEntity questions");
      for (const q of qs) {
        if (!q.name || !q.acceptedAnswer?.text) errors.push("Every FAQ question needs name and acceptedAnswer.text");
        else if (!text.includes(q.name.toLowerCase().slice(0, 40))) errors.push(`FAQ question not found on the page: "${q.name.slice(0, 60)}"`);
      }
    }
    if (types.some((t) => /Review|AggregateRating/.test(t))) {
      const nums = JSON.stringify(n).match(/"(?:ratingValue|reviewCount|ratingCount)"\s*:\s*"?([\d.]+)/g) ?? [];
      for (const m of nums) {
        const v = m.match(/([\d.]+)$/)![1];
        if (!text.includes(v)) errors.push(`Rating figure ${v} doesn't appear on the page`);
      }
    }
    if (types.includes("WebPage") && n.url && String(n.url).replace(/\/$/, "") !== url.replace(/\/$/, "")) errors.push(`WebPage url must be ${url}`);
  }
  return errors;
}

export async function proposeSchema(siteId: string, cwd: string, audit: SeoPageAudit, extra: PageExtra, site: { name: string; origin: string; homeText: string; isHome: boolean }) {
  let prompt = `Write schema.org JSON-LD for this page. It will be printed in <head>.

PAGE: ${audit.url}
Title: ${audit.title}
H1: ${audit.h1.join(" | ")}
Content blocks detected: ${extra.blocks.join(", ") || "plain content"}
Existing schema on the page (don't duplicate it): ${audit.schemaTypes.join(", ") || "none"}

PAGE TEXT:
${extra.text}

${site.isHome ? `This is the homepage. Also include the site-wide nodes: the business as the most specific LocalBusiness subtype (or Organization) with "@id":"${site.origin}/#organization", plus WebSite with "@id":"${site.origin}/#website".` : `Reference the business as {"@id":"${site.origin}/#organization"} (it's defined on the homepage).`}

Rules:
- One object {"@context":"https://schema.org","@graph":[…]}.
- Always a WebPage (or AboutPage / ContactPage) node with url "${audit.url}", name, and isPartOf {"@id":"${site.origin}/#website"}. Add a BreadcrumbList.
- Cover every content block that has a schema.org equivalent: FAQPage for accordions and FAQs (questions and answers copied from the page), Service for each service described, VideoObject for embedded videos, Review only for real testimonials shown on the page, Menu / Offer for listed prices.
- Every value must come from the page text. No invented ratings, prices, dates, reviews or opening hours. Leave a property out rather than guess.`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await runClaude({
      leadId: siteId, task: "seo", cwd,
      system: "You are a technical SEO who writes valid, conservative schema.org JSON-LD that passes Google's Rich Results Test.",
      prompt: `${prompt}\n\nReturn only the JSON in a \`\`\`json block.`,
    });
    try {
      const jsonld = extractJson<Record<string, unknown>>(res.text);
      const errors = validateSchema(jsonld, `${extra.text}\n${site.homeText}`, audit.url);
      const types = [...new Set(((jsonld["@graph"] as Record<string, unknown>[] | undefined) ?? [jsonld]).flatMap((n) => [n["@type"]].flat().map(String)))];
      if (!errors.length || attempt === 2) return { jsonld, types, errors };
      prompt += `\n\nYOUR PREVIOUS JSON-LD FAILED THESE CHECKS. Fix them:\n${errors.map((e) => `- ${e}`).join("\n")}`;
    } catch (e) {
      if (attempt === 2) return { jsonld: null, types: [], errors: [`Could not parse JSON-LD: ${(e as Error).message}`] };
    }
  }
  return { jsonld: null, types: [], errors: ["No schema produced"] };
}
