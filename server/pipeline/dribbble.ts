import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "../db.ts";
import { newContext, settle, UA_DESKTOP, DESKTOP } from "./browser.ts";

/**
 * Dribbble fallback — a fresh reference design for a niche we have no moc for.
 *
 * When the moc queue (design-library/<niche>/mocs) has nothing for a lead's vertical, we don't want
 * to drop back to the one generic layout. Instead we fetch a relevant, professionally designed shot
 * from Dribbble and clone THAT, exactly like a library moc. Shots are cached under the data dir and a
 * per-query "used" list is kept, so each generation for the same vertical pulls a DIFFERENT design
 * (paginating through Dribbble's results) rather than repeating one.
 *
 * Best-effort by design: Dribbble may be slow, offline or bot-blocked. Any failure returns null and the
 * caller falls back to the recipe / design-system rotation. It never throws into the pipeline.
 */

export interface DribbbleMoc { niche: string; path: string }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "web";

function cacheDir(key: string) {
  const d = join(DATA, "dribbble-cache", key);
  mkdirSync(d, { recursive: true });
  return d;
}

const USAGE_FILE = join(DATA, "dribbble-usage.json");
type Usage = Record<string, string[]>; // query key -> shot image URLs already used
function readUsage(): Usage {
  try { return existsSync(USAGE_FILE) ? (JSON.parse(readFileSync(USAGE_FILE, "utf8")) as Usage) : {}; } catch { return {}; }
}
function writeUsage(u: Usage) {
  try { writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2)); } catch { /* best effort */ }
}

/** A tight search query from the lead's vertical text: the first few real words + web-design intent. */
function queryFor(verticalText: string): string {
  const stop = new Set(["the", "and", "for", "with", "your", "our", "best", "local", "near", "quality", "service", "services", "company", "business", "ltd", "inc", "llc"]);
  const words = (verticalText.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !stop.has(w));
  const uniq = [...new Set(words)].slice(0, 3);
  return `${uniq.join(" ")} website landing page`.trim();
}

/**
 * Fetch (and cache) one Dribbble shot image to clone for this vertical, or null if unavailable.
 * `niche` is only a label for bookkeeping; the search is driven by the vertical text.
 */
export async function fetchDribbbleMoc(verticalText: string, niche: string): Promise<DribbbleMoc | null> {
  const query = queryFor(verticalText);
  const key = slug(query);
  let ctx: Awaited<ReturnType<typeof newContext>> | null = null;
  try {
    const usage = readUsage();
    const used = usage[key] ?? [];
    // Page deeper into results as we exhaust earlier ones, so repeats pull genuinely new designs.
    const pageNo = Math.floor(used.length / 12) + 1;
    const url = `https://dribbble.com/search/shots/popular/web-design?q=${encodeURIComponent(query)}&page=${pageNo}`;

    ctx = await newContext({ viewport: DESKTOP, userAgent: UA_DESKTOP });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await settle(page).catch(() => {});

    // Collect candidate shot images (Dribbble serves previews from its CDN), largest/first first.
    const candidates: string[] = await page.$$eval("img", (imgs) =>
      imgs
        .map((im) => {
          const el = im as HTMLImageElement;
          // Prefer the biggest entry in srcset, else src.
          const srcset = el.getAttribute("srcset") || "";
          const fromSet = srcset.split(",").map((s) => s.trim().split(" ")[0]).filter(Boolean).pop();
          return fromSet || el.currentSrc || el.src || "";
        })
        .filter((u) => /cdn\.dribbble\.com\/.+\.(png|jpe?g|webp)/i.test(u))
        // Drop avatars / tiny assets.
        .filter((u) => !/\/(avatars|users)\//i.test(u)),
    ).catch(() => [] as string[]);

    const pick = candidates.find((u) => !used.includes(u));
    if (!pick) return null;

    // Download the image bytes through the same context (shares UA/cookies).
    const resp = await ctx.request.get(pick, { timeout: 30000 });
    if (!resp.ok()) return null;
    const buf = await resp.body();
    if (!buf || buf.length < 4000) return null; // too small to be a real shot

    const ext = (pick.match(/\.(png|jpe?g|webp)/i)?.[1] || "png").toLowerCase().replace("jpeg", "jpg");
    const file = join(cacheDir(key), `${used.length + 1}.${ext}`);
    writeFileSync(file, buf);

    usage[key] = [...used, pick];
    writeUsage(usage);
    return { niche, path: file };
  } catch {
    return null; // offline, blocked, or layout changed — caller falls back
  } finally {
    await ctx?.close().catch(() => {});
  }
}
