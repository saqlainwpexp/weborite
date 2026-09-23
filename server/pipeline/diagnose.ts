import { join } from "node:path";
import { existsSync } from "node:fs";
import lighthouse from "lighthouse";
import { chromium } from "playwright";
import { leadDir, readJson, writeJson } from "../db.ts";
import { extractJson, runClaude } from "../claude/runner.ts";
import { listBenchmarkSets } from "./benchmarks.ts";
import { saturation, type CaptureOutput } from "./capture.ts";
import type { Capture, Diagnosis, Issue } from "../../shared/types.ts";

const MOBILE_TITLES: Record<string, string> = {
  "horizontal-scroll": "Page scrolls sideways on phones",
  "fixed-overlap": "Fixed bars cover too much of the screen on phones",
  "small-text": "Text is too small to read on phones",
  "tap-targets": "Links and buttons are too small to tap",
  "overflowing-media": "Images spill past the screen edge on phones",
  "nav-toggle": "Mobile menu doesn't work",
};

async function runLighthouse(url: string) {
  // Playwright launches Chromium with a debugging port and Lighthouse drives it over that port.
  const port = 9300 + Math.floor(Math.random() * 500);
  let browser: import("playwright").Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] });
    const result = await lighthouse(url, {
      port,
      output: "json",
      logLevel: "error",
      onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
    });
    return result?.lhr ?? null;
  } catch (e) {
    console.warn("[lighthouse] failed:", (e as Error).message);
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}

function lum(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Deterministic brand roles from the area-weighted palette. Never creative. */
export function brandFromPalette(p: Capture["palette"]): Diagnosis["brand"] {
  const byRole = (role: string) => p.filter((c) => c.role === role).sort((a, b) => b.weight - a.weight)[0]?.hex;
  const background = byRole("page") ?? p.find((c) => lum(c.hex) > 0.8)?.hex ?? "#ffffff";
  const text = byRole("text") ?? byRole("heading") ?? "#111111";
  const chroma = p
    .filter((c) => saturation(c.hex) > 0.28 && lum(c.hex) > 0.02 && lum(c.hex) < 0.9)
    .map((c) => ({ ...c, score: c.weight * (c.role === "button" ? 4 : c.role === "header" || c.role === "link" ? 2 : 1) }))
    .sort((a, b) => b.score - a.score);
  const dark = p.filter((c) => lum(c.hex) < 0.05 && c.role !== "text").sort((a, b) => b.weight - a.weight)[0]?.hex;
  const primary = chroma[0]?.hex ?? dark ?? text;
  return { primary, secondary: chroma[1]?.hex ?? dark, accent: chroma[2]?.hex, background, text };
}

export async function diagnose(leadId: string, cap: CaptureOutput): Promise<{ diagnosis: Diagnosis; vertical: { key: string; label: string; register: string } }> {
  const dir = leadDir(leadId);
  const issues: Issue[] = [];

  for (const m of cap.mobile.filter((m) => !m.pass)) {
    issues.push({ severity: m.id === "nav-toggle" || m.id === "horizontal-scroll" ? "high" : "medium", category: "mobile", title: MOBILE_TITLES[m.id] ?? m.id, detail: m.detail });
  }
  if (cap.contrast.length) {
    const worst = [...cap.contrast].sort((a, b) => a.ratio - b.ratio)[0];
    issues.push({
      severity: cap.contrast.length > 10 ? "high" : "medium",
      category: "contrast",
      title: `${cap.contrast.length} text elements fail WCAG contrast`,
      detail: `Worst: "${worst.text}" at ${worst.ratio}:1 (${worst.fg} on ${worst.bg}). Needs 4.5:1.`,
    });
  }

  // Cached so a job that pauses on Claude doesn't repeat the ~20s Lighthouse run.
  type Lhr = NonNullable<Awaited<ReturnType<typeof runLighthouse>>>;
  let lhr = readJson<Lhr>(leadId, "lighthouse.json");
  if (!lhr) {
    lhr = await runLighthouse(cap.capture.finalUrl);
    if (lhr) writeJson(leadId, "lighthouse.json", { categories: lhr.categories, audits: lhr.audits });
  }
  const score = (k: string) => Math.round((lhr?.categories[k]?.score ?? 0) * 100);
  const lighthouseScores = lhr
    ? { performance: score("performance"), accessibility: score("accessibility"), bestPractices: score("best-practices"), seo: score("seo") }
    : null;
  if (lhr) {
    const pick = ["largest-contentful-paint", "cumulative-layout-shift", "total-blocking-time", "image-alt", "document-title", "meta-description", "heading-order", "link-name", "button-name", "viewport", "font-size", "uses-responsive-images", "modern-image-formats", "render-blocking-resources"];
    for (const id of pick) {
      const a = lhr.audits[id];
      if (!a || a.score === null || a.score >= 0.5) continue;
      issues.push({
        severity: a.score < 0.2 && /contentful|layout-shift|viewport/.test(id) ? "high" : "low",
        category: /image-alt|heading|link-name|button-name|font-size/.test(id) ? "structure" : /title|description/.test(id) ? "seo" : "performance",
        title: a.title,
        detail: a.displayValue ? `${a.displayValue}`.replace(/\u00c2?\u00a0/g, " ") : (a.description ?? "").split(". ")[0].replace(/\[(.*?)\]\(.*?\)/g, "$1"),
      });
    }
  }

  const brand = brandFromPalette(cap.capture.palette);

  // Claude: choose the strongest asset, add visual issues a script can't see, classify the vertical.
  const sets = listBenchmarkSets().map((s) => ({ key: s.vertical, label: s.label, register: s.register, examples: s.sites.slice(0, 3).map((x) => x.name) }));
  const assetList = cap.capture.assets.map((a) => ({ path: a.path, kind: a.kind, size: a.width && a.height ? `${a.width}x${a.height}` : "unknown", aboveFold: a.aboveFold, renderedArea: a.area }));
  const images = [join(dir, "desktop-fold.jpg"), join(dir, "mobile.jpg")].filter(existsSync);

  const res = await runClaude({
    leadId,
    task: "diagnose",
    cwd: dir,
    images,
    system: "You are a senior web designer reviewing a small-business homepage before it is rebuilt. You are precise and brief, and you only state what you can see or what the data shows.",
    prompt: `Site: ${cap.capture.finalUrl}
Title: ${cap.capture.title}
Description: ${cap.capture.description}

Screenshots attached: desktop above-the-fold, and the full mobile page at 375px.

Downloaded media (paths are relative to the lead folder; video entries may be YouTube/Vimeo embeds):
${JSON.stringify(assetList, null, 1)}

Issues already found by automated checks:
${issues.map((i) => "- " + i.title + ": " + i.detail).join("\n") || "- none"}

Existing benchmark verticals:
${JSON.stringify(sets, null, 1)}

Tasks:
1. strongestAsset: choose the single strongest existing visual asset from the media list (a hero video beats a still image unless it is clearly weak). Use its exact path. If nothing is usable, use null.
2. issues: up to 5 more visual or content problems you can see in the screenshots that the automated list doesn't already cover (for example weak hierarchy, cluttered hero, unclear call to action, dated styling, or nav clutter). Be concrete.
3. vertical: classify the business by its competitive register, meaning what the buyer is actually evaluating, not the literal trade or platform. Test: would this business feel reassured or embarrassed sitting next to that set's competitors? Reuse an existing key when it fits. Otherwise propose a new kebab-case key, a label, and a one-sentence register. The label must be 1–2 plain words naming what the business is, the way a client would say it, e.g. "WordPress Developer", "Pizzeria", "Dental Clinic" or "Wedding Photographer". Never use a long descriptive phrase. Put the nuance in the register.

Return only JSON:
\`\`\`json
{"strongestAsset": {"path": "...", "reason": "..."} | null,
 "issues": [{"severity": "high|medium|low", "category": "content|structure|mobile|contrast|performance", "title": "...", "detail": "..."}],
 "vertical": {"key": "...", "label": "...", "register": "..."}}
\`\`\``,
  });

  const out = extractJson<{
    strongestAsset: { path: string; reason: string } | null;
    issues: Issue[];
    vertical: { key: string; label: string; register: string };
  }>(res.text);

  let strongest: Diagnosis["strongestAsset"] = null;
  if (out.strongestAsset) {
    const a = cap.capture.assets.find((x) => x.path === out.strongestAsset!.path);
    if (a) strongest = { path: a.path, kind: a.kind, reason: out.strongestAsset.reason };
  }
  if (!strongest) {
    // Fall back to a deterministic pick: video first, then the largest above-the-fold image.
    const a = cap.capture.assets.find((x) => x.kind === "video") ?? [...cap.capture.assets].sort((x, y) => (y.aboveFold ? 1 : 0) - (x.aboveFold ? 1 : 0) || (y.area ?? 0) - (x.area ?? 0))[0];
    if (a) strongest = { path: a.path, kind: a.kind, reason: "Largest prominent media on the current homepage (automatic pick)." };
  }

  const diagnosis: Diagnosis = {
    lighthouse: lighthouseScores,
    issues: [...issues, ...(out.issues ?? []).slice(0, 5)],
    strongestAsset: strongest,
    brand,
  };
  writeJson(leadId, "diagnosis.json", diagnosis);
  const key = (out.vertical?.key || "general-local-business").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const label = (out.vertical?.label || key.replace(/-/g, " ")).trim().split(/\s+/).slice(0, 3).join(" ");
  return { diagnosis, vertical: { key, label, register: out.vertical?.register || "" } };
}

/**
 * Design-from-scratch leads have no site to audit. Claude proposes brand colours that suit the
 * business (and its photos), picks the best photo for the hero, and classifies the vertical.
 */
export async function diagnoseScratch(leadId: string, cap: CaptureOutput): Promise<{ diagnosis: Diagnosis; vertical: { key: string; label: string; register: string } }> {
  const dir = leadDir(leadId);
  const sets = listBenchmarkSets().map((s) => ({ key: s.vertical, label: s.label, register: s.register, examples: s.sites.slice(0, 3).map((x) => x.name) }));
  const photos = cap.capture.assets.filter((a) => a.kind === "image");
  const images = [...photos.slice(0, 4).map((a) => join(dir, a.path)), join(dir, "desktop-fold.jpg")].filter(existsSync);
  const res = await runClaude({
    leadId,
    task: "diagnose",
    cwd: dir,
    images,
    system: "You are a senior brand and web designer planning a first website for a small business that has none. You are precise and brief.",
    prompt: `Business: ${cap.capture.title}
Category: ${cap.capture.description}
It has no website; customers only find its Google Maps listing.

Facts from the listing:
${cap.facts.map((f) => `- ${f.text}`).join("\n")}

Photos from the listing (in order, paths relative to the lead folder):
${photos.map((a, i) => `${i + 1}. ${a.path}`).join("\n") || "none"}
The attached images are the first photos, then a screenshot of the listing.

Existing benchmark verticals:
${JSON.stringify(sets, null, 1)}

Tasks:
1. brand: propose a palette for this business: primary, secondary, accent, background (light), text (dark). Base it on the photos (storefront, signage, uniforms, food, interiors) when they show a clear colour identity, otherwise on what suits the category. Hex values. The primary must work as a button colour with white or near-black text.
2. strongestAsset: the single best photo for the homepage hero (sharp, relevant, not a logo, menu, map or screenshot). Use its exact path, or null if none is usable.
3. vertical: classify the business by its competitive register (what the buyer is evaluating). Reuse an existing key when it fits, otherwise propose a new kebab-case key, a 1–2 word label ("Pizzeria", "HVAC Contractor") and a one-sentence register.

Return only JSON:
\`\`\`json
{"brand": {"primary": "#…", "secondary": "#…", "accent": "#…", "background": "#…", "text": "#…"},
 "strongestAsset": {"path": "...", "reason": "..."} | null,
 "vertical": {"key": "...", "label": "...", "register": "..."}}
\`\`\``,
  });
  const out = extractJson<{ brand: Diagnosis["brand"]; strongestAsset: { path: string; reason: string } | null; vertical: { key: string; label: string; register: string } }>(res.text);
  const hex = (v: unknown, d: string) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : d);
  const brand: Diagnosis["brand"] = {
    primary: hex(out.brand?.primary, "#1f4f46"),
    secondary: out.brand?.secondary ? hex(out.brand.secondary, "#2f5d50") : undefined,
    accent: out.brand?.accent ? hex(out.brand.accent, "#c8913a") : undefined,
    background: hex(out.brand?.background, "#ffffff"),
    text: hex(out.brand?.text, "#141414"),
  };
  const sa = out.strongestAsset && photos.find((a) => a.path === out.strongestAsset!.path);
  const pick = sa ?? photos[0];
  const diagnosis: Diagnosis = {
    lighthouse: null,
    issues: [
      { severity: "high", category: "content", title: "No website", detail: "People who search for the business only find its Google Maps listing, with no page of its own to show services, prices, photos or a way to get in touch." },
      { severity: "medium", category: "seo", title: "Nothing to rank in search", detail: "Without a site the business can't appear in regular Google results for its services, only on the map." },
    ],
    strongestAsset: pick ? { path: pick.path, kind: "image", reason: sa ? out.strongestAsset!.reason : "First photo from the listing (automatic pick)." } : null,
    brand,
  };
  writeJson(leadId, "diagnosis.json", diagnosis);
  const key = (out.vertical?.key || "general-local-business").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const label = (out.vertical?.label || key.replace(/-/g, " ")).trim().split(/\s+/).slice(0, 3).join(" ");
  return { diagnosis, vertical: { key, label, register: out.vertical?.register || "" } };
}
