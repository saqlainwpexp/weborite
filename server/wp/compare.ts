import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { newContext } from "../pipeline/browser.ts";

const MAX_H = 9000;

async function shoot(url: string, width: number, mobile: boolean, path: string) {
  const ctx = await newContext({ viewport: { width, height: 900 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    await page.evaluate(async () => {
      document.querySelectorAll("img[loading=lazy]").forEach((i) => i.setAttribute("loading", "eager"));
      for (let y = 0; y < document.body.scrollHeight; y += 700) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(800);
    const h = Math.min(await page.evaluate(() => document.documentElement.scrollHeight), MAX_H);
    await page.screenshot({ path, clip: { x: 0, y: 0, width, height: h }, fullPage: true, animations: "disabled" });
  } finally {
    await ctx.close();
  }
}

/** Screenshot the HTML original and the WordPress render; return the % of pixels that differ. */
export async function comparePages(htmlUrl: string, wpUrl: string, dir: string) {
  const out: { desktop: number; mobile: number } = { desktop: 100, mobile: 100 };
  for (const [key, width, mobile] of [["desktop", 1440, false], ["mobile", 375, true]] as const) {
    const a = join(dir, `${key}-html.png`);
    const b = join(dir, `${key}-wp.png`);
    await shoot(htmlUrl, width, mobile, a);
    await shoot(wpUrl, width, mobile, b);
    const A = PNG.sync.read(readFileSync(a));
    const B = PNG.sync.read(readFileSync(b));
    const w = Math.min(A.width, B.width);
    const h = Math.min(A.height, B.height);
    const crop = (img: PNG) => {
      const c = new PNG({ width: w, height: h });
      PNG.bitblt(img, c, 0, 0, w, h, 0, 0);
      return c;
    };
    const diff = new PNG({ width: w, height: h });
    const mismatched = pixelmatch(crop(A).data, crop(B).data, diff.data, w, h, { threshold: 0.15, includeAA: false });
    writeFileSync(join(dir, `${key}-diff.png`), PNG.sync.write(diff));
    // Height differences count as mismatched rows.
    const total = w * Math.max(A.height, B.height);
    const extra = w * Math.abs(A.height - B.height);
    out[key] = Math.round(((mismatched + extra) / total) * 1000) / 10;
  }
  return out;
}
