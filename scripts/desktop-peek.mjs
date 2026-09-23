// Screenshot every page of the running desktop app (started with STUDIO_DEBUG_PORT=9333).
//   node scripts/desktop-peek.mjs <outDir> [navigate-path]
import { chromium } from "playwright";
import { join } from "node:path";

const out = process.argv[2] ?? ".";
const go = process.argv[3];
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
let i = 0;
for (const ctx of browser.contexts()) {
  for (const page of ctx.pages()) {
    const url = page.url();
    if (go && url.includes("127.0.0.1:43")) {
      await page.evaluate((p) => { history.pushState({}, "", p); dispatchEvent(new PopStateEvent("popstate")); }, go);
      await page.waitForTimeout(1500);
    }
    const file = join(out, `peek-${i++}.png`);
    await page.screenshot({ path: file }).catch((e) => console.log("shot failed", url, e.message));
    console.log(file, page.url(), await page.title());
  }
}
await browser.close().catch(() => {});
process.exit(0);
