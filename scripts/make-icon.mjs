// Render the app icon (build/icon.png, 512×512) from the white-label logo in Settings, or the default mark.
//   node scripts/make-icon.mjs
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const root = join(import.meta.dirname, "..");
const brandDir = join(root, "data", "brand");
const logo = existsSync(brandDir) ? readdirSync(brandDir).filter((f) => f.startsWith("logo-")).sort().pop() : null;
const mime = (f) => (f.endsWith(".svg") ? "image/svg+xml" : f.endsWith(".png") ? "image/png" : f.endsWith(".jpg") ? "image/jpeg" : "image/webp");
const inner = logo
  ? `<img src="data:${mime(logo)};base64,${readFileSync(join(brandDir, logo)).toString("base64")}" style="width:100%;height:100%;object-fit:contain">`
  : `<svg viewBox="0 0 26 26" width="340" height="340" fill="none" style="color:#fff"><path d="M13 2.5 20.4 5.6 23.5 13 20.4 20.4 13 23.5 5.6 20.4 2.5 13 5.6 5.6Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M13 2.5V9M13 17v6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const html = `<html><body style="margin:0;width:512px;height:512px;display:grid;place-items:center;background:transparent">
<div style="width:512px;height:512px;border-radius:112px;overflow:hidden;background:${logo ? "#000" : "#2f5d50"};display:grid;place-items:center">${inner}</div></body></html>`;

mkdirSync(join(root, "build"), { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
await page.setContent(html);
await page.screenshot({ path: join(root, "build", "icon.png"), omitBackground: true });
await browser.close();
console.log(`build/icon.png from ${logo ?? "the default mark"}`);
