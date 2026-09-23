import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { hideOverlays, newContext, settle, UA_DESKTOP, UA_MOBILE } from "../pipeline/browser.ts";
import type { CareEnv, CarePageCheck, CareStatus } from "../../shared/types.ts";

const FATAL = /There has been a critical error on (this|your) website|<b>Fatal error<\/b>|Fatal error:\s|Parse error:\s|Uncaught (Error|TypeError|ArgumentCountError)/i;
const FREEZE = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important} video,iframe{visibility:hidden!important}";

export type Cookie = { name: string; value: string; url: string };
export const stagingCookie = (stagingUrl: string, token: string): Cookie[] => [{ name: "studio_stg", value: token, url: new URL(stagingUrl).origin }];

/** Map a live page URL onto another base (the staging folder). */
export function onBase(liveUrl: string, liveOrigin: string, base: string) {
  const u = new URL(liveUrl);
  return base.replace(/\/$/, "") + (u.origin === new URL(liveOrigin).origin ? u.pathname + u.search : u.pathname);
}

/**
 * Load each page, note status / PHP fatal / console errors, and take a screenshot with motion frozen.
 * Desktop for every page, mobile for the first three.
 */
export async function capturePages(base: string, paths: string[], dir: string, tag: string, cookies: Cookie[] = []): Promise<CarePageCheck[]> {
  mkdirSync(dir, { recursive: true });
  const out: CarePageCheck[] = [];
  for (const [vi, vp] of [{ width: 1440, height: 900, ua: UA_DESKTOP, name: "d" }, { width: 390, height: 844, ua: UA_MOBILE, name: "m" }].entries()) {
    const ctx = await newContext({ viewport: { width: vp.width, height: vp.height }, userAgent: vp.ua, reducedMotion: "reduce", isMobile: vi === 1, hasTouch: vi === 1 });
    if (cookies.length) await ctx.addCookies(cookies);
    try {
      for (const [i, path] of paths.entries()) {
        if (vi === 1 && i >= 3) break;
        const page = await ctx.newPage();
        let consoleErrors = 0;
        page.on("console", (m) => m.type() === "error" && consoleErrors++);
        page.on("pageerror", () => consoleErrors++);
        const url = base.replace(/\/$/, "") + path;
        const res = await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(async () => page.goto(url, { waitUntil: "load", timeout: 45000 }).catch(() => null));
        const status = res?.status() ?? 0;
        const html = await page.content().catch(() => "");
        const file = `${tag}-${vp.name}-${i}.png`;
        try {
          await settle(page);
          await hideOverlays(page);
          await page.addStyleTag({ content: FREEZE });
          await page.waitForTimeout(500);
          const height = Math.min(await page.evaluate(() => document.documentElement.scrollHeight), 6000);
          await page.screenshot({ path: join(dir, file), fullPage: true, clip: { x: 0, y: 0, width: vp.width, height: Math.max(height, vp.height) } });
        } catch {
          /* page too broken to screenshot: status/fatal still recorded */
        }
        const key = vi === 1 ? `${path} (mobile)` : path;
        out.push({ path: key, status, fatal: FATAL.test(html), consoleErrors, diff: null, [tag.endsWith("before") ? "before" : "after"]: existsSync(join(dir, file)) ? file : undefined });
        await page.close();
      }
    } finally {
      await ctx.close();
    }
  }
  return out;
}

/** % of pixels that changed. Pages of different height are padded; the extra rows count as changed. */
export function diffShots(dir: string, before: string, after: string, outName: string): number | null {
  if (!existsSync(join(dir, before)) || !existsSync(join(dir, after))) return null;
  const A = PNG.sync.read(readFileSync(join(dir, before)));
  const B = PNG.sync.read(readFileSync(join(dir, after)));
  const w = Math.max(A.width, B.width);
  const h = Math.max(A.height, B.height);
  const pad = (img: PNG) => {
    if (img.width === w && img.height === h) return img.data;
    const p = new PNG({ width: w, height: h });
    p.data.fill(255);
    PNG.bitblt(img, p, 0, 0, img.width, img.height, 0, 0);
    return p.data;
  };
  const D = new PNG({ width: w, height: h });
  const n = pixelmatch(pad(A), pad(B), D.data, w, h, { threshold: 0.12, includeAA: false, alpha: 0.25 });
  writeFileSync(join(dir, outName), PNG.sync.write(D));
  return Math.round((n / (w * h)) * 10000) / 100;
}

/** Merge a "before" and an "after" capture into one list with diffs. */
export function comparePages(dir: string, before: CarePageCheck[], after: CarePageCheck[], tag: string): CarePageCheck[] {
  return after.map((a, i) => {
    const b = before.find((x) => x.path === a.path);
    const diff = b?.before && a.after ? diffShots(dir, b.before, a.after, `${tag}-diff-${i}.png`) : null;
    return { ...a, before: b?.before, diff, diffImage: diff !== null ? `${tag}-diff-${i}.png` : undefined, beforeStatus: b?.status, beforeConsole: b?.consoleErrors };
  });
}

/** Staging must match live on everything that decides whether an update works. */
export function compareEnv(live: CareEnv, staging: CareEnv, livePlugins: CareStatus["plugins"], stagingPlugins: CareStatus["plugins"]) {
  const diffs: string[] = [];
  for (const k of ["wp", "php", "db", "server", "sapi", "memory_limit", "wp_memory", "max_exec", "locale", "https"] as const) {
    if (String(live[k]) !== String(staging[k])) diffs.push(`${k}: live ${live[k]} · staging ${staging[k]}`);
  }
  const missing = live.extensions.filter((e) => !staging.extensions.includes(e));
  if (missing.length) diffs.push(`PHP extensions missing on staging: ${missing.join(", ")}`);
  for (const p of livePlugins) {
    const s = stagingPlugins.find((x) => x.file === p.file);
    if (!s) diffs.push(`${p.name} missing on staging`);
    else if (s.version !== p.version || s.active !== p.active) diffs.push(`${p.name}: live ${p.version}${p.active ? "" : " (inactive)"} · staging ${s.version}${s.active ? "" : " (inactive)"}`);
  }
  return { matches: diffs.length === 0, diffs };
}

/** Plugins that were active before and aren't after: WordPress deactivates a plugin that fatals on activation. */
export function deactivated(before: CareStatus["plugins"], after: CareStatus["plugins"]) {
  return before.filter((p) => p.active && !after.find((a) => a.file === p.file)?.active).map((p) => p.name);
}

/** Quick check between individual updates: does the home page still render? */
export async function smoke(url: string, cookies: Cookie[] = []) {
  const headers: Record<string, string> = { "User-Agent": UA_DESKTOP };
  if (cookies.length) headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  try {
    const r = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(45000) });
    const html = await r.text();
    const fatal = FATAL.test(html);
    return { ok: r.status < 500 && !fatal && r.status !== 403, status: r.status, fatal };
  } catch (e) {
    return { ok: false, status: 0, fatal: false, error: (e as Error).message };
  }
}
