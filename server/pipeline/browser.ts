import { chromium, type Browser } from "playwright";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

let browser: Browser | null = null;
let healing: Promise<void> | null = null;

/** True for the "browser isn't installed / was just updated" launch error. */
const isMissingBrowser = (msg: string) => /Executable doesn't exist|npx playwright install|please run the following command|was just installed or updated|Failed to launch|ENOENT/i.test(msg);

/**
 * Install the Chromium build this Playwright version needs. Playwright's browser lives in a shared
 * cache, and every Playwright update expects a new build — so after an npm/app update the old browser
 * no longer matches and scraping breaks. This reinstalls it on demand (once) so lead search, captures
 * and SEO keep working without the user running any command.
 */
function installChromium(): Promise<void> {
  if (healing) return healing;
  healing = new Promise((resolve, reject) => {
    let cli: string;
    try {
      const require = createRequire(import.meta.url);
      cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
    } catch (e) {
      return reject(new Error(`Can't locate the Playwright CLI to install the browser: ${(e as Error).message}`));
    }
    console.log("Installing the Chromium browser Playwright needs (one-time, ~150 MB)…");
    // ELECTRON_RUN_AS_NODE lets the packaged app run the CLI with its bundled Node.
    execFile(process.execPath, [cli, "install", "chromium"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 5 * 60000, windowsHide: true }, (err, _out, stderr) => {
      if (err) return reject(new Error(`Couldn't install the browser automatically: ${(stderr || err.message).slice(0, 300)}. Run "npx playwright install chromium" once.`));
      console.log("Chromium installed.");
      resolve();
    });
  });
  return healing;
}

export async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    if (!isMissingBrowser((e as Error).message)) throw e;
    await installChromium();
    healing = null; // allow a fresh attempt if a future update breaks it again
    browser = await chromium.launch({ headless: true });
  }
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
