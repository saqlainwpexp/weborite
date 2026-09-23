import { newContext } from "../pipeline/browser.ts";

export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 StudioQA";
const SKIP = /\.(pdf|jpe?g|png|gif|webp|avif|svg|zip|mp4|webm|docx?|xlsx?)(\?|$)|\/wp-(admin|login|json|content)\/|\/feed\/?$|\?replytocom=|#/i;

async function fetchText(url: string) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000), redirect: "follow" });
    return r.ok ? await r.text() : "";
  } catch {
    return "";
  }
}

/** Page URLs from sitemap.xml / wp-sitemap.xml (follows sitemap indexes one level). */
async function fromSitemap(origin: string) {
  const urls = new Set<string>();
  for (const path of ["/sitemap.xml", "/wp-sitemap.xml", "/sitemap_index.xml"]) {
    const xml = await fetchText(origin + path);
    if (!xml.includes("<loc>")) continue;
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    for (const loc of locs) {
      if (/sitemap[^/]*\.xml/i.test(loc)) {
        // Skip post/taxonomy/user sitemaps; keep pages.
        if (/users|tags?|categor|author|taxonom/i.test(loc)) continue;
        const sub = await fetchText(loc);
        for (const m of sub.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) urls.add(m[1].replace(/&amp;/g, "&"));
      } else urls.add(loc);
    }
    if (urls.size) break;
  }
  return [...urls].filter((u) => u.startsWith(origin) && !SKIP.test(u));
}

/** Discover the site's pages: sitemap first, otherwise follow internal links from the homepage. */
export async function discoverPages(siteUrl: string, max = 40): Promise<{ url: string; title: string }[]> {
  const origin = new URL(siteUrl).origin;
  const found = new Set<string>([origin + "/"]);
  for (const u of await fromSitemap(origin)) found.add(u);

  const ctx = await newContext({ userAgent: UA });
  const titles = new Map<string, string>();
  try {
    const page = await ctx.newPage();
    const queue = [...found];
    const seen = new Set<string>();
    while (queue.length && seen.size < max) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);
      try {
        const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        if (!res || res.status() >= 400) continue;
        titles.set(url, await page.title());
        const links = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href));
        for (const l of links) {
          const clean = l.split("#")[0];
          if (clean.startsWith(origin) && !SKIP.test(clean) && !seen.has(clean) && !queue.includes(clean) && found.size < max) {
            found.add(clean);
            queue.push(clean);
          }
        }
      } catch {
        /* unreachable page: skip */
      }
    }
  } finally {
    await ctx.close();
  }
  return [...titles.entries()].map(([url, title]) => ({ url, title })).slice(0, max);
}
