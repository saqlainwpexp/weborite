import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, DATA, leadDir } from "../db.ts";
import { newContext } from "./browser.ts";
import type { Capture } from "../../shared/types.ts";

/**
 * Image handling for generation. Two problems it solves:
 *  - The generator only saw file names like 94e468fbcc.jpeg, so it couldn't tell a work photo from a
 *    partner logo or a certificate and put brand logos into photo slots. assetSheet() renders every
 *    captured image as a numbered, labelled contact sheet it can actually look at.
 *  - Many small-business sites have few usable photos. stockPhotos() adds relevant, curated stock
 *    photos (design-library/_stock/stock.json) as a fallback, downloaded into the lead's assets.
 */

/**
 * Logos are often saved as big squares with a thin mark in the middle (a 736×736 JPEG holding a
 * 300×40 wordmark). Set 40px tall in a ticker they become specks. Crop away uniform white or
 * transparent margins into <name>-trim.png and return a map of original path → trimmed path.
 * Photos are left alone: only images whose margins are ≥12% on some side and flat are cropped.
 */
export async function trimPadding(leadId: string, capture: Capture): Promise<Record<string, string>> {
  const dir = leadDir(leadId);
  const out: Record<string, string> = {};
  const list = capture.assets.filter((a) => a.kind === "image" && existsSync(join(dir, a.path)) && !/\.svg$/i.test(a.path));
  if (!list.length) return out;
  const ctx = await newContext({ viewport: { width: 800, height: 600 } });
  try {
    const page = await ctx.newPage();
    for (const a of list) {
      const trimmed = a.path.replace(/\.[a-z0-9]+$/i, "-trim.png");
      if (existsSync(join(dir, trimmed))) { out[a.path] = trimmed; continue; }
      const ext = a.path.split(".").pop()!.toLowerCase();
      const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
      const dataUrl = `data:${mime};base64,${readFileSync(join(dir, a.path)).toString("base64")}`;
      const png = await page.evaluate(async (src) => {
        const img = new Image();
        img.src = src;
        await img.decode().catch(() => {});
        const w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h || w * h > 12e6) return null;
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const g = c.getContext("2d")!;
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, w, h).data;
        // Background = the corner colour; "empty" = transparent or within 18 of it on every channel.
        const bg = [d[0], d[1], d[2]];
        const empty = (i: number) => d[i + 3] < 16 || (Math.abs(d[i] - bg[0]) < 18 && Math.abs(d[i + 1] - bg[1]) < 18 && Math.abs(d[i + 2] - bg[2]) < 18);
        if (d[3] >= 16 && (bg[0] + bg[1] + bg[2]) / 3 < 225) return null; // opaque, non-white corner: a photo
        let x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
          if (empty((y * w + x) * 4)) continue;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        if (x1 < 0) return null;
        const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.04);
        x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
        const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
        if (Math.max(x0, w - 1 - x1) / w < 0.12 && Math.max(y0, h - 1 - y1) / h < 0.12) return null; // already tight
        const o = document.createElement("canvas");
        o.width = cw; o.height = ch;
        o.getContext("2d")!.drawImage(c, x0, y0, cw, ch, 0, 0, cw, ch);
        return o.toDataURL("image/png");
      }, dataUrl);
      if (!png) continue;
      writeFileSync(join(dir, trimmed), Buffer.from(png.split(",")[1], "base64"));
      out[a.path] = trimmed;
    }
  } finally {
    await ctx.close();
  }
  return out;
}

/** A labelled contact sheet of every captured image, saved as <lead>/asset-sheet.jpg. */
export async function assetSheet(leadId: string, capture: Capture, trimmed: Record<string, string> = {}): Promise<string | null> {
  const dir = leadDir(leadId);
  const imgs = [
    ...(capture.logo ? [{ path: capture.logo.path, note: "LOGO (locked)", w: capture.logo.width, h: capture.logo.height }] : []),
    ...capture.assets.filter((a) => a.kind === "image" && a.path !== capture.logo?.path).map((a) => ({ path: trimmed[a.path] ?? a.path, note: basename(new URL(a.sourceUrl, "https://x/").pathname).slice(0, 48), w: trimmed[a.path] ? undefined : a.width, h: a.height })),
  ].filter((i) => existsSync(join(dir, i.path)));
  if (!imgs.length) return null;

  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:16px;background:#fff;font:14px/1.3 Arial,sans-serif;color:#111}
    .g{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
    .t{border:1px solid #ccc}
    .i{height:190px;display:flex;align-items:center;justify-content:center;background:repeating-conic-gradient(#eee 0 25%,#fff 0 50%) 0 0/16px 16px}
    .i img{max-width:100%;max-height:190px;object-fit:contain}
    .c{padding:6px 8px;border-top:1px solid #ccc}.c b{font-size:15px}.c span{display:block;color:#555;font-size:12px;word-break:break-all}
  </style><div class="g">${imgs
    .map((i) => `<div class="t"><div class="i"><img src="${esc(i.path)}"></div><div class="c"><b>${esc(i.path)}</b>${i.w && i.h ? ` · ${i.w}×${i.h}` : ""}<span>${esc(i.note)}</span></div></div>`)
    .join("")}</div>`;
  const file = join(dir, "asset-sheet.html");
  writeFileSync(file, html);
  const ctx = await newContext({ viewport: { width: 1200, height: 800 } });
  try {
    const page = await ctx.newPage();
    await page.goto(pathToFileURL(file).href, { waitUntil: "load", timeout: 30000 });
    const out = join(dir, "asset-sheet.jpg");
    await page.screenshot({ path: out, type: "jpeg", quality: 75, fullPage: true });
    return out;
  } catch {
    return null;
  } finally {
    await ctx.close();
    try { unlinkSync(file); } catch { /* already gone */ }
  }
}

interface StockPhoto { id: string; url: string; subject: string; topics: string[] }

// Words in a lead's vertical (label, key, register) → stock topics. Dutch trade words included: most leads are NL.
const TOPIC_WORDS: Record<string, RegExp> = {
  hvac: /hvac|airco|air.?condition|cooling|koel|heating|verwarm|heat.?pump|warmtepomp|klimaat|ventilat|furnace|\bac\b/i,
  plumbing: /plumb|loodgieter|riool|drain|sewer|bathroom|badkamer|boiler|\bcv\b|pipe|leak|lekkage/i,
  electrical: /electric|elektr|wiring|installateur/i,
  solar: /solar|zonne/i,
  roofing: /roof|dak/i,
  construction: /construct|build|bouw|contractor|aannem|renovat|verbouw|concrete|remodel|extension/i,
  handyman: /handyman|klus|home repair|maintenance|onderhoud/i,
  painting: /paint|schilder|decorat/i,
  carpentry: /carpent|timmer|joiner|woodwork/i,
  restaurant: /restaurant|eatery|dining|diner|bistro|brasserie|eetcaf|trattoria|kitchen|keuken|food|eten/i,
  pizza: /pizz/i,
  burger: /burger|fries|friet|fast.?food|snack/i,
  italian: /italian|itali|pasta|trattoria|pizz/i,
  asian: /sushi|ramen|asian|aziat|japan|thai|chinese|chinees|noodle|wok|poke|korean|vietnam/i,
  grill: /grill|kebab|kebap|steak|bbq|barbecue|turk|shawarma|d[oö]ner|meat|vlees|shoarma/i,
  cafe: /caf[eé]|coffee|koffie|bakery|bakker|brunch|lunch|patisser|lunchroom/i,
  bar: /\bbar\b|cocktail|wine|wijn|pub\b|lounge/i,
};

// Food businesses fall back on dining-room and service shots, not living rooms.
const FOOD = new Set(["restaurant", "pizza", "burger", "italian", "asian", "grill", "cafe", "bar"]);

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function stockCatalog(): StockPhoto[] {
  for (const d of [join(DATA, "design-library"), join(ROOT, "design-library")]) {
    const f = join(d, "_stock", "stock.json");
    if (existsSync(f)) {
      try { return (JSON.parse(readFileSync(f, "utf8")) as { photos: StockPhoto[] }).photos; } catch { /* fall through */ }
    }
  }
  return [];
}

/**
 * Up to `n` stock photos that fit the lead's trade, downloaded into <lead>/assets/stock-<id>.jpg.
 * The same lead always gets the same set; different leads in one trade get different orders.
 * Returns only what downloaded, so an offline run simply has no stock fallback.
 */
export async function stockPhotos(leadId: string, vertical: string, n = 8): Promise<{ src: string; subject: string }[]> {
  const topics = Object.entries(TOPIC_WORDS).filter(([, re]) => re.test(vertical)).map(([t]) => t);
  const all = stockCatalog();
  const seed = hash(leadId);
  const rank = (p: StockPhoto) => hash(p.id + seed);
  // Specific topics first (pizza before "restaurant", AC units before a boiler room): photos whose
  // main topic is one of them, then photos that merely mention one; the general fallback fills up.
  const fallback = topics.some((t) => FOOD.has(t)) ? "restaurant" : "home";
  const specific = topics.filter((t) => t !== fallback);
  const main = (p: StockPhoto) => (specific.includes(p.topics[0]) ? 0 : 1);
  const trade = all.filter((p) => p.topics.some((t) => specific.includes(t))).sort((a, b) => main(a) - main(b) || rank(a) - rank(b));
  const home = all.filter((p) => p.topics.includes(fallback) && !trade.includes(p)).sort((a, b) => rank(a) - rank(b));
  const pick = [...trade.slice(0, n - 2), ...home].slice(0, n);

  const dir = join(leadDir(leadId), "assets");
  mkdirSync(dir, { recursive: true });
  const out: { src: string; subject: string }[] = [];
  await Promise.all(pick.map(async (p) => {
    const rel = `assets/stock-${p.id}.jpg`;
    const file = join(leadDir(leadId), rel);
    if (!existsSync(file)) {
      try {
        const res = await fetch(`${p.url}?w=1600&q=75&fm=jpg&fit=max`, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) return;
        writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      } catch {
        return;
      }
    }
    out.push({ src: rel, subject: p.subject });
  }));
  return pick.map((p) => out.find((o) => o.src.includes(p.id))).filter((o): o is { src: string; subject: string } => Boolean(o));
}
