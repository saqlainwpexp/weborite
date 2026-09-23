import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { leadDir } from "../db.ts";
import type { GateResult } from "../../shared/types.ts";
import { DESKTOP, MOBILE, newContext, settle } from "./browser.ts";

const SHOT_H = 2600;

async function shootMockup(dir: string) {
  const url = pathToFileURL(join(dir, "mockup", "index.html")).href;
  for (const [vp, file, mobile] of [[DESKTOP, "mockup-desktop.jpg", false], [MOBILE, "mockup-mobile.jpg", true]] as const) {
    const ctx = await newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    await settle(page);
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({ path: join(dir, file), type: "jpeg", quality: 80, fullPage: true, clip: { x: 0, y: 0, width: vp.width, height: Math.min(h, 7000) } });
    await ctx.close();
  }
}

const img = (p: string) => (existsSync(p) ? `data:image/jpeg;base64,${readFileSync(p).toString("base64")}` : "");

/** Old vs new, desktop and mobile, with the three hard constraints as badges. */
export async function renderSideBySide(leadId: string, meta: { business: string; url: string; gate: GateResult | null }) {
  const dir = leadDir(leadId);
  await shootMockup(dir);
  const badge = (name: string) => {
    const c = meta.gate?.checks.find((x) => x.name === name);
    if (!c) return "";
    return `<div class="badge ${c.pass ? "ok" : "bad"}"><b>${c.pass ? "✓" : "✕"} ${name}</b><span>${c.detail.replace(/</g, "&lt;")}</span></div>`;
  };
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0}
    body{font-family:Inter,"Segoe UI",system-ui,sans-serif;background:#f0eeef;color:#0e0c0d;padding:48px;width:2000px}
    h1{font-weight:400;font-size:40px;letter-spacing:-.02em}
    .sub{color:#767475;font-size:18px;margin-top:8px}
    .badges{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:32px 0}
    .badge{background:#fff;border-radius:16px;padding:18px 20px;border:1px solid #ececec}
    .badge b{display:block;font-weight:500;font-size:17px;margin-bottom:6px}
    .badge span{font-size:14px;color:#767475;line-height:1.4}
    .ok b{color:#2f7a4f}.bad b{color:#b03a3a}
    .row{display:grid;gap:24px;margin-top:24px}
    .desk{grid-template-columns:1fr 1fr}.mob{grid-template-columns:1fr 1fr}
    .pane{background:#fff;border-radius:20px;padding:16px;border:1px solid #ececec}
    .label{font-size:14px;color:#767475;margin:0 4px 12px;display:flex;justify-content:space-between}
    .label b{color:#0e0c0d;font-weight:500}
    .frame{height:${SHOT_H / 2}px;overflow:hidden;border-radius:12px;background:#f7f5f6}
    .mob .frame{height:1100px;width:420px;margin:0 auto}
    .frame img{width:100%;display:block}
  </style></head><body>
    <h1>${meta.business.replace(/</g, "&lt;")}</h1>
    <div class="sub">${meta.url} · current site vs rebuilt mockup</div>
    <div class="badges">${badge("Strongest asset kept")}${badge("Brand logo and colours kept")}${badge("Every figure traces to the source site")}</div>
    <div class="row desk">
      <div class="pane"><div class="label"><b>Current</b><span>Desktop 1440</span></div><div class="frame"><img src="${img(join(dir, "desktop.jpg"))}"></div></div>
      <div class="pane"><div class="label"><b>Mockup</b><span>Desktop 1440</span></div><div class="frame"><img src="${img(join(dir, "mockup-desktop.jpg"))}"></div></div>
    </div>
    <div class="row mob">
      <div class="pane"><div class="label"><b>Current</b><span>Mobile 375</span></div><div class="frame"><img src="${img(join(dir, "mobile.jpg"))}"></div></div>
      <div class="pane"><div class="label"><b>Mockup</b><span>Mobile 375</span></div><div class="frame"><img src="${img(join(dir, "mockup-mobile.jpg"))}"></div></div>
    </div>
  </body></html>`;
  const ctx = await newContext({ viewport: { width: 2000, height: 1200 } });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: join(dir, "side-by-side.png"), fullPage: true });
  await ctx.close();
}
