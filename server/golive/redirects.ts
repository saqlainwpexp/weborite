import type { GoLiveRedirect } from "../../shared/types.ts";
import { fromSitemap, UA } from "../seo/crawl.ts";

const SKIP = /\.(css|js|jpe?g|png|gif|webp|avif|svg|ico|woff2?|ttf|mp4|webm|zip)(\?|$)|\/wp-(admin|json|includes|content)\/|\/feed\/?$|\/xmlrpc\.php|\?replytocom=|mailto:|tel:/i;

async function html(url: string) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(20000) });
    return r.ok && /html/i.test(r.headers.get("content-type") ?? "") ? { text: await r.text(), url: r.url } : null;
  } catch {
    return null;
  }
}

/** Every URL the old site has: its sitemap(s) plus a link crawl, so pages missing from the sitemap still get a redirect. */
export async function oldSiteUrls(oldOrigin: string, max = 300) {
  const origin = new URL(oldOrigin).origin;
  const found = new Set<string>([origin + "/"]);
  for (const u of await fromSitemap(origin, true)) found.add(u.split("#")[0]);
  const queue = [...found];
  const seen = new Set<string>();
  while (queue.length && seen.size < 120 && found.size < max) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const page = await html(url);
    if (!page) continue;
    for (const m of page.text.matchAll(/href=["']([^"'#]+)["']/gi)) {
      let abs: string;
      try {
        abs = new URL(m[1].replace(/&amp;/g, "&"), page.url).href;
      } catch {
        continue;
      }
      if (!abs.startsWith(origin) || SKIP.test(abs) || found.has(abs)) continue;
      found.add(abs);
      queue.push(abs);
    }
  }
  return [...found].map((u) => new URL(u)).map((u) => u.pathname + u.search).filter((p, i, a) => a.indexOf(p) === i);
}

const stem = (w: string) => (w.length > 4 ? w.replace(/(ies)$/, "y").replace(/(?<!s)s$/, "") : w);
const words = (p: string) => decodeURIComponent(p).toLowerCase().replace(/\.(html?|php|aspx?)$/, "").split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !/^\d+$/.test(w) && !["index", "html", "php", "page", "the", "and", "our", "www"].includes(w)).map(stem);
const norm = (p: string) => ("/" + p.replace(/^\/+|\/+$/g, "") + "/").replace(/^\/\/$/, "/").toLowerCase();

const HINTS: [RegExp, RegExp][] = [
  [/contact|get-in-touch|enquir|reach/, /contact/],
  [/about|who-we-are|story|team/, /about/],
  [/service|what-we-do|solutions/, /service/],
  [/menu|price|pricing|rates/, /menu|pric/],
  [/gallery|portfolio|work|projects|showcase|photos/, /gallery|portfolio|work|project|showcase/],
  [/blog|news|articles|posts/, /blog|news/],
  [/shop|store|products?/, /shop|store|product/],
  [/faq|questions/, /faq/],
  [/review|testimonial/, /review|testimonial/],
  [/privacy/, /privacy/],
  [/terms|conditions/, /terms/],
];

/** Pair each old path with the closest new page; paths that still exist on the new site need no redirect. */
export function proposeRedirects(oldPaths: string[], newPaths: string[]): GoLiveRedirect[] {
  const newSet = new Set(newPaths.map(norm));
  const out: GoLiveRedirect[] = [];
  for (const p of oldPaths) {
    const n = norm(p.split("?")[0]);
    if (n === "/" || newSet.has(n)) continue;
    const w = words(n);
    let best = "/";
    let score = 0;
    for (const cand of newPaths) {
      const cw = words(cand);
      if (!cw.length) continue;
      const shared = w.filter((x) => cw.includes(x)).length;
      const s = shared / new Set([...w, ...cw]).size + (w.at(-1) && cw.at(-1) === w.at(-1) ? 0.5 : 0);
      if (s > score) {
        score = s;
        best = norm(cand);
      }
    }
    let note = score > 0 ? "Closest page by its address" : "No similar page: sent to the homepage";
    if (score < 0.34) {
      const hint = HINTS.find(([o]) => o.test(n));
      const target = hint && newPaths.map(norm).find((c) => hint[1].test(c));
      if (target) {
        best = target;
        note = "Same kind of page";
      }
    }
    out.push({ from: p, to: best, note });
  }
  return out;
}
