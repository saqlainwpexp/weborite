import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { layoutChecks } from "../server/pipeline/layout.ts";
const b = await chromium.launch();
for (const lead of process.argv.slice(2)) for (const width of [1440, 1280]) {
  const c = await b.newContext({ viewport: { width, height: 900 } }); await c.addInitScript({ content: "window.__name = window.__name || ((f) => f);" }); const p = await c.newPage();
  await p.goto(pathToFileURL(resolve(`data/leads/${lead}/mockup/index.html`)).href, { waitUntil: "load" });
  await p.waitForTimeout(800);
  console.log(lead, width, JSON.stringify(await layoutChecks(p), null, 1));
  await p.close();
}
await b.close();
