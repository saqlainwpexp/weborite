import { chromium, type Browser } from "playwright";

let browser: Browser | null = null;

export async function getBrowser() {
  if (!browser || !browser.isConnected()) browser = await chromium.launch({ headless: true });
  return browser;
}

/** New context with a shim for the `__name` helper tsx injects into functions passed to page.evaluate. */
export async function newContext(options: import("playwright").BrowserContextOptions) {
  const ctx = await (await getBrowser()).newContext(options);
  await ctx.addInitScript({ content: "window.__name = window.__name || ((f) => f);" });
  return ctx;
}

export const DESKTOP = { width: 1440, height: 900 };
export const MOBILE = { width: 375, height: 812 };
export const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
export const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** Scroll through the page so lazy-loaded images and animations settle before screenshots. */
export async function settle(page: import("playwright").Page) {
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.8;
    const max = Math.min(document.body.scrollHeight, 12000);
    for (let y = 0; y < max; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(600);
}

/** Hide common cookie/consent overlays so screenshots show the actual page. */
export async function hideOverlays(page: import("playwright").Page) {
  await page
    .evaluate(() => {
      const sel = '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[class*="gdpr" i]';
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        if (el === document.body || el === document.documentElement) continue;
        const pos = getComputedStyle(el).position;
        if (pos === "fixed" || pos === "sticky") el.style.setProperty("display", "none", "important");
      }
    })
    .catch(() => {});
}
