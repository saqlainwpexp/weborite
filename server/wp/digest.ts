import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Page } from "playwright";
import { newContext } from "../pipeline/browser.ts";

export interface SectionDigest {
  index: number;
  label: string;
  tag: string;
  desktop: string;      // measured spec at 1440px
  mobile: string;       // only the values that change at 375px
  html: string;         // trimmed outerHTML for text + structure
  shotDesktop: string;  // png paths
  shotMobile: string;
  height: number;
}

export interface PageDigest {
  fonts: string[];      // Google Fonts families the page loads
  bodyBg: string;
  sections: SectionDigest[];
}

/** Runs in the page: tag every section and return a measured spec for each. */
function measure(): { fonts: string[]; bodyBg: string; sections: { label: string; tag: string; lines: string[]; html: string; height: number }[] } {
  const rgbToHex = (c: string) => {
    const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    if (!m) return c;
    const a = m[4] !== undefined ? Number(m[4]) : 1;
    if (a === 0) return "transparent";
    const hex = "#" + [m[1], m[2], m[3]].map((v) => Math.round(+v).toString(16).padStart(2, "0")).join("");
    return a < 1 ? `rgba(${m[1]},${m[2]},${m[3]},${a})` : hex;
  };
  const px = (v: string) => (v.endsWith("px") ? String(Math.round(parseFloat(v) * 10) / 10) : v);
  const box = (s: CSSStyleDeclaration, p: string) => {
    const vals = ["top", "right", "bottom", "left"].map((k) => px(s.getPropertyValue(`${p}-${k}`)));
    return vals.every((v) => v === "0") ? "" : vals.join("/");
  };

  const roots: Element[] = [];
  const header = document.querySelector("body > header");
  if (header) roots.push(header);
  const main = document.querySelector("main");
  if (main) roots.push(...Array.from(main.children).filter((e) => e.getBoundingClientRect().height > 4));
  for (const e of Array.from(document.body.children)) {
    if (e === header || e === main || e.tagName === "SCRIPT" || e.tagName === "FOOTER") continue;
    if (e.getBoundingClientRect().height > 4) roots.push(e);
  }
  const footer = document.querySelector("body > footer") ?? Array.from(document.querySelectorAll("footer")).pop();
  if (footer) roots.push(footer);

  const describe = (el: Element, depth: number, out: string[], budget: { n: number }) => {
    if (budget.n <= 0) return;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (s.display === "none" || s.visibility === "hidden" || r.width < 1 || r.height < 1) return;
    const tag = el.tagName.toLowerCase();
    const cls = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 2).join(".");
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent!.trim()).join(" ").replace(/\s+/g, " ").trim();
    const props: string[] = [`${Math.round(r.width)}x${Math.round(r.height)}`];
    if (s.display.includes("flex")) props.push(`flex ${s.flexDirection}${s.flexWrap === "wrap" ? " wrap" : ""} justify:${s.justifyContent} align:${s.alignItems}${s.gap !== "normal" && s.gap !== "0px" ? ` gap:${px(s.rowGap)}/${px(s.columnGap)}` : ""}`);
    if (s.display.includes("grid")) props.push(`grid cols:${s.gridTemplateColumns.split(" ").length} (${s.gridTemplateColumns.slice(0, 60)}) gap:${px(s.rowGap)}/${px(s.columnGap)}`);
    const pad = box(s, "padding");
    if (pad) props.push(`pad:${pad}`);
    const mar = ["top", "right", "bottom", "left"].map((k) => px(s.getPropertyValue(`margin-${k}`)));
    if (!mar.every((v) => v === "0")) props.push(`margin:${mar.join("/")}`);
    if (s.maxWidth !== "none") props.push(`max-w:${px(s.maxWidth)}`);
    const bg = rgbToHex(s.backgroundColor);
    if (bg !== "transparent") props.push(`bg:${bg}`);
    if (s.backgroundImage !== "none") props.push(`bg-img:${s.backgroundImage.slice(0, 140)}`);
    if (s.borderTopStyle !== "none" && parseFloat(s.borderTopWidth) > 0) props.push(`border:${px(s.borderTopWidth)} ${s.borderTopStyle} ${rgbToHex(s.borderTopColor)}`);
    else for (const side of ["Bottom", "Left", "Right"] as const) {
      const w = parseFloat(s.getPropertyValue(`border-${side.toLowerCase()}-width`));
      if (w > 0 && s.getPropertyValue(`border-${side.toLowerCase()}-style`) !== "none") props.push(`border-${side.toLowerCase()}:${w}px ${rgbToHex(s.getPropertyValue(`border-${side.toLowerCase()}-color`))}`);
    }
    if (s.borderTopLeftRadius !== "0px") props.push(`radius:${px(s.borderTopLeftRadius)}`);
    if (s.boxShadow !== "none") props.push(`shadow:${s.boxShadow.slice(0, 80)}`);
    if (s.position === "absolute" || s.position === "fixed" || s.position === "sticky") props.push(`pos:${s.position} top:${px(s.top)} left:${px(s.left)}`);
    if (parseFloat(s.opacity) < 1) props.push(`opacity:${s.opacity}`);
    const textish = own || ["img", "svg", "video", "iframe", "input", "textarea", "button"].includes(tag);
    if (own) {
      props.push(`font:[${s.fontFamily.replace(/["']/g, "").slice(0, 90)}] ${px(s.fontSize)}/${s.lineHeight === "normal" ? "normal" : px(s.lineHeight)} w${s.fontWeight}${s.fontStyle === "italic" ? " italic" : ""}`);
      props.push(`color:${rgbToHex(s.color)}`);
      if (s.letterSpacing !== "normal") props.push(`ls:${px(s.letterSpacing)}`);
      if (s.textTransform !== "none") props.push(s.textTransform);
      if (s.textAlign !== "start" && s.textAlign !== "left") props.push(`align:${s.textAlign}`);
      if (s.textDecorationLine !== "none") props.push(`deco:${s.textDecorationLine}`);
    }
    if (tag === "img") props.push(`src:${(el as HTMLImageElement).getAttribute("src")} alt:"${(el as HTMLImageElement).alt}" fit:${s.objectFit}`);
    if (tag === "video") props.push(`video src:${(el as HTMLVideoElement).currentSrc || el.querySelector("source")?.getAttribute("src")}`);
    if (tag === "a") props.push(`href:${el.getAttribute("href")}`);
    if (tag === "svg") props.push(`svg(${(el.getAttribute("aria-label") || el.querySelector("title")?.textContent || "icon").slice(0, 30)}) fill:${rgbToHex(s.fill)}`);
    const layoutish = s.display.includes("flex") || s.display.includes("grid") || bg !== "transparent" || pad || s.borderTopLeftRadius !== "0px";
    if (textish || layoutish || depth === 0 || tag === "a") {
      out.push(`${"  ".repeat(depth)}<${tag}${cls ? "." + cls : ""}> ${props.join(" ")}${own ? ` "${own.slice(0, 160)}"` : ""}`);
      budget.n--;
    }
    if (tag === "svg") return;
    for (const c of Array.from(el.children)) describe(c, depth + 1, out, budget);
  };

  const sections = roots.map((el, i) => {
    el.setAttribute("data-studio-section", String(i));
    const lines: string[] = [];
    describe(el, 0, lines, { n: 220 });
    const h = el.querySelector("h1,h2,h3")?.textContent?.trim();
    const label = el.tagName === "HEADER" ? "Header" : el.tagName === "FOOTER" ? "Footer" : el.id || h?.slice(0, 40) || `Section ${i + 1}`;
    const html = el.outerHTML.replace(/\s+/g, " ").replace(/<svg[\s\S]*?<\/svg>/g, "<svg/>").slice(0, 12000);
    return { label, tag: el.tagName.toLowerCase(), lines, html, height: Math.round(el.getBoundingClientRect().height) };
  });

  const fonts = Array.from(document.querySelectorAll('link[href*="fonts.googleapis"]'))
    .flatMap((l) => [...(l.getAttribute("href") || "").matchAll(/family=([^:&]+)/g)].map((m) => decodeURIComponent(m[1]).replace(/\+/g, " ")));
  return { fonts, bodyBg: rgbToHex(getComputedStyle(document.body).backgroundColor), sections };
}

async function loadAt(url: string, width: number, height: number, mobile: boolean) {
  const ctx = await newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
  // Load lazy images so screenshots and sizes are real.
  await page.evaluate(async () => {
    document.querySelectorAll("img[loading=lazy]").forEach((i) => i.setAttribute("loading", "eager"));
    for (let y = 0; y < document.body.scrollHeight; y += 700) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(500);
  return { ctx, page };
}

async function shoot(page: Page, index: number, path: string) {
  const el = page.locator(`[data-studio-section="${index}"]`);
  await el.screenshot({ path, animations: "disabled" }).catch(() => {});
}

/** Measure a page section by section at desktop and mobile widths. */
export async function digestPage(url: string, outDir: string, only?: number[]): Promise<PageDigest> {
  mkdirSync(outDir, { recursive: true });
  const d = await loadAt(url, 1440, 900, false);
  const m = await loadAt(url, 375, 812, true);
  try {
    const desk = await d.page.evaluate(measure);
    const mob = await m.page.evaluate(measure);
    const sections: SectionDigest[] = [];
    for (let i = 0; i < desk.sections.length; i++) {
      if (only && !only.includes(i)) continue;
      const shotDesktop = join(outDir, `section-${i}-desktop.png`);
      const shotMobile = join(outDir, `section-${i}-mobile.png`);
      await shoot(d.page, i, shotDesktop);
      await shoot(m.page, i, shotMobile);
      const dl = desk.sections[i].lines;
      const ml = mob.sections[i]?.lines ?? [];
      // Mobile: keep only the lines whose measurements differ from desktop.
      const strip = (l: string) => l.replace(/^(\s*<[^>]+>)\s*\d+x\d+/, "$1");
      const mobileDiff = ml.filter((line, n) => strip(line) !== strip(dl[n] ?? ""));
      sections.push({
        index: i,
        label: desk.sections[i].label,
        tag: desk.sections[i].tag,
        desktop: dl.join("\n"),
        mobile: mobileDiff.join("\n"),
        html: desk.sections[i].html,
        shotDesktop,
        shotMobile,
        height: desk.sections[i].height,
      });
    }
    return { fonts: desk.fonts, bodyBg: desk.bodyBg, sections };
  } finally {
    await d.ctx.close();
    await m.ctx.close();
  }
}
