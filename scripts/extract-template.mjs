// Measure a real HTML template in Chromium and write its exact design numbers into the design library.
//
//   node scripts/extract-template.mjs <path/to/index.html> <slug>
//
// Writes design-library/<slug>/measured.json (computed spacing, type scale, buttons, cards, the
// section-by-section blueprint) and reference-1..N.jpg (the page cut into readable 1440px-wide slices).
// The design-system.json next to it is hand-written from these numbers plus the screenshots.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const [file, slug] = process.argv.slice(2);
if (!file || !slug) {
  console.error("usage: node scripts/extract-template.mjs <index.html> <slug>");
  process.exit(1);
}
const out = resolve("design-library", slug);
mkdirSync(out, { recursive: true });

// File URLs count as one origin here, so the placeholder check below can read image pixels.
const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(pathToFileURL(resolve(file)).href, { waitUntil: "load", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1500);

// Templates hide content behind preloaders and scroll-reveal animations: kill them all.
await page.addStyleTag({
  content: `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important}
  .wow,.aos-init,[data-aos],.animated,.reveal,.fadeInUp,.fadeIn{visibility:visible!important;opacity:1!important;transform:none!important}
  #preloader,.preloader,.loader,.page-loader,.loader-wrap,#loading,.preloader-wrap,.loading{display:none!important}
  html,body{overflow-x:hidden!important;max-width:100vw}`,
});
for (let y = 0; y < 30000; y += 700) {
  await page.evaluate((yy) => window.scrollTo(0, yy), y);
  await page.waitForTimeout(60);
  if (y > (await page.evaluate(() => document.documentElement.scrollHeight))) break;
}
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(800);
// Freeze carousels on their current slide so a slide change can't blank the hero mid-capture.
await page.evaluate(() => {
  const id = setTimeout(() => {}, 0);
  for (let k = 0; k <= id; k++) { clearTimeout(k); clearInterval(k); }
  window.setTimeout = window.setInterval = () => 0;
  window.requestAnimationFrame = () => 0;
});

const data = await page.evaluate(() => {
  const px = (v) => Math.round(parseFloat(v) || 0);
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && +cs.opacity > 0.05;
  };
  const rgbHex = (c) => {
    const m = c && c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(",").map((s) => parseFloat(s));
    if (a < 0.1) return null;
    return "#" + [r, g, b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("") + (a < 1 ? ` @${Math.round(a * 100)}%` : "");
  };
  const text = (el) => (el.innerText || "").replace(/\s+/g, " ").trim();
  const family = (f) => f.split(",")[0].replace(/["']/g, "").trim();
  const absY = (el) => Math.round(el.getBoundingClientRect().top + scrollY);

  const typo = (el) => {
    const cs = getComputedStyle(el);
    return {
      text: text(el).slice(0, 70),
      family: family(cs.fontFamily),
      size: px(cs.fontSize),
      weight: +cs.fontWeight,
      lineHeight: cs.lineHeight === "normal" ? "normal" : +(parseFloat(cs.lineHeight) / parseFloat(cs.fontSize)).toFixed(2),
      letterSpacing: cs.letterSpacing === "normal" ? 0 : +(parseFloat(cs.letterSpacing)).toFixed(2),
      transform: cs.textTransform !== "none" ? cs.textTransform : undefined,
      style: cs.fontStyle !== "normal" ? cs.fontStyle : undefined,
      color: rgbHex(cs.color),
      marginBottom: px(cs.marginBottom),
    };
  };
  const box = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(px).join(" "),
      radius: cs.borderTopLeftRadius === cs.borderBottomRightRadius ? px(cs.borderTopLeftRadius) : [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(px).join(" "),
      bg: rgbHex(cs.backgroundColor) || (cs.backgroundImage !== "none" ? (cs.backgroundImage.includes("gradient") ? "gradient" : "image") : null),
      border: px(cs.borderTopWidth) ? `${px(cs.borderTopWidth)}px ${cs.borderTopStyle} ${rgbHex(cs.borderTopColor)}` : undefined,
      shadow: cs.boxShadow !== "none" ? cs.boxShadow.replace(/rgba?\([^)]+\)/g, (c) => rgbHex(c) || c) : undefined,
    };
  };

  // --- Buttons: anything that looks like a CTA.
  const btnEls = [...document.querySelectorAll("a,button")].filter((el) => {
    if (!vis(el)) return false;
    const cs = getComputedStyle(el);
    const hasFill = rgbHex(cs.backgroundColor) || cs.backgroundImage.includes("gradient") || px(cs.borderTopWidth) > 0;
    const r = el.getBoundingClientRect();
    return hasFill && r.height >= 36 && r.height <= 80 && r.width >= 90 && r.width <= 420 && text(el).length > 2 && text(el).length < 40;
  });
  const btnKey = (b) => `${b.padding}|${b.radius}|${b.bg}|${b.border}|${b.size}`;
  const buttons = new Map();
  for (const el of btnEls) {
    const cs = getComputedStyle(el);
    const b = { ...box(el), text: text(el), size: px(cs.fontSize), weight: +cs.fontWeight, family: family(cs.fontFamily), transform: cs.textTransform !== "none" ? cs.textTransform : undefined, letterSpacing: cs.letterSpacing === "normal" ? 0 : +parseFloat(cs.letterSpacing).toFixed(2), color: rgbHex(cs.color) };
    const k = btnKey(b);
    if (!buttons.has(k)) buttons.set(k, { ...b, count: 0, examples: [] });
    const e = buttons.get(k);
    e.count++;
    if (e.examples.length < 3) e.examples.push(b.text);
  }

  // --- Containers: the content column width.
  const widths = {};
  for (const el of document.querySelectorAll("[class*=container],[class*=wrapper],[class*=inner]")) {
    if (!vis(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.maxWidth === "none") continue;
    const k = `${px(cs.maxWidth)} (padding-x ${px(cs.paddingLeft)})`;
    widths[k] = (widths[k] || 0) + 1;
  }

  // --- Sections: descend through single full-width wrappers until we have the page's stacked bands.
  const isBand = (el) => {
    const r = el.getBoundingClientRect();
    return vis(el) && r.width >= innerWidth * 0.9 && r.height >= 60;
  };
  let layer = [document.body];
  for (let i = 0; i < 6; i++) {
    const kids = layer.flatMap((el) => [...el.children].filter(isBand));
    if (kids.length > layer.length) layer = kids;
    else if (kids.length === 1 && layer.length === 1) layer = kids;
    else break;
  }
  const bands = layer.filter((el) => !/^(SCRIPT|STYLE|NOSCRIPT|svg)$/i.test(el.tagName));

  const sectionInfo = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    // First descendant with real padding tells us the section rhythm when the band itself has none.
    let padEl = el;
    for (const d of [el, ...el.querySelectorAll("*")].slice(0, 40)) {
      const c = getComputedStyle(d);
      if (px(c.paddingTop) >= 30 || px(c.paddingBottom) >= 30) { padEl = d; break; }
    }
    const pcs = getComputedStyle(padEl);
    const heads = [...el.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(vis);
    // Eyebrow: a short line just above the first big heading, smaller & often uppercase/coloured.
    const h0 = heads[0];
    let eyebrow;
    if (h0) {
      const prev = [...el.querySelectorAll("span,p,div,h6,h5,h4")].filter((e) => vis(e) && e.children.length <= 2 && text(e).length > 2 && text(e).length < 40 && e.getBoundingClientRect().bottom <= h0.getBoundingClientRect().top + 2 && h0.getBoundingClientRect().top - e.getBoundingClientRect().bottom < 40).pop();
      if (prev) eyebrow = typo(prev);
    }
    // Repeated siblings = cards/columns.
    const groups = [];
    for (const p of el.querySelectorAll("*")) {
      const kids = [...p.children].filter((k) => vis(k) && k.getBoundingClientRect().width > 120 && k.getBoundingClientRect().height > 80);
      if (kids.length < 2) continue;
      const cls = kids.map((k) => k.className && typeof k.className === "string" ? k.className.split(" ").sort().join(".") : k.tagName);
      if (new Set(cls).size !== 1) continue;
      const tops = kids.map((k) => Math.round(k.getBoundingClientRect().top));
      const perRow = tops.filter((t) => Math.abs(t - tops[0]) < 5).length;
      const r0 = kids[0].getBoundingClientRect(), r1 = kids[1].getBoundingClientRect();
      const gapX = perRow > 1 ? Math.round(r1.left - r0.right) : undefined;
      // The visible card surface may be a child of the column.
      let card = kids[0];
      for (const d of [kids[0], ...kids[0].querySelectorAll("*")].slice(0, 6)) {
        const b = box(d);
        if (b.bg || b.shadow || b.border) { card = d; break; }
      }
      groups.push({ count: kids.length, perRow, itemWidth: Math.round(r0.width), gapX, card: box(card), firstText: text(kids[0]).slice(0, 90) });
    }
    groups.sort((a, b) => b.count * b.itemWidth - a.count * a.itemWidth);
    const imgs = [...el.querySelectorAll("img")].filter(vis).map((i) => { const b = i.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), radius: px(getComputedStyle(i).borderTopLeftRadius) }; }).filter((i) => i.w > 60);
    const paras = [...el.querySelectorAll("p")].filter((p) => vis(p) && text(p).length > 40);
    const bgImg = cs.backgroundImage !== "none" || [...el.querySelectorAll("*")].slice(0, 15).some((d) => getComputedStyle(d).backgroundImage.includes("url("));
    return {
      tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === "string" ? el.className : "").slice(0, 80),
      y: absY(el),
      height: Math.round(r.height),
      paddingY: `${px(pcs.paddingTop)} / ${px(pcs.paddingBottom)}`,
      bg: rgbHex(cs.backgroundColor) || rgbHex(pcs.backgroundColor) || (bgImg ? "photo/pattern" : "transparent"),
      bgImage: bgImg || undefined,
      eyebrow,
      headings: heads.slice(0, 4).map((h) => ({ tag: h.tagName.toLowerCase(), ...typo(h) })),
      paragraph: paras[0] ? typo(paras[0]) : undefined,
      repeated: groups.slice(0, 2),
      images: imgs.slice(0, 4),
      imageCount: imgs.length,
    };
  };

  const bodyCs = getComputedStyle(document.body);
  const firstP = [...document.querySelectorAll("p")].find((p) => vis(p) && text(p).length > 60);
  const nav = [...document.querySelectorAll("nav a, .main-menu a, .navigation a, header li a")].find(vis);
  const header = document.querySelector("header") || bands[0];
  const inputs = [...document.querySelectorAll("input[type=text],input[type=email],input:not([type]),select,textarea")].filter(vis).slice(0, 2);

  return {
    title: document.title,
    pageHeight: document.documentElement.scrollHeight,
    body: { family: family(bodyCs.fontFamily), size: px(bodyCs.fontSize), lineHeight: +(parseFloat(bodyCs.lineHeight) / parseFloat(bodyCs.fontSize)).toFixed(2) || bodyCs.lineHeight, color: rgbHex(bodyCs.color), bg: rgbHex(bodyCs.backgroundColor) },
    paragraph: firstP ? typo(firstP) : undefined,
    nav: nav ? typo(nav) : undefined,
    header: header ? { height: Math.round(header.getBoundingClientRect().height), ...box(header) } : undefined,
    inputs: inputs.map((i) => ({ ...box(i), size: px(getComputedStyle(i).fontSize) })),
    containers: Object.entries(widths).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ×${n}`),
    buttons: [...buttons.values()].sort((a, b) => b.count - a.count).slice(0, 6),
    sections: bands.map(sectionInfo),
  };
});

writeFileSync(join(out, "measured.json"), JSON.stringify(data, null, 1));

// Stock templates ship grey "1920x900" placeholder images. Left in, the model reads the giant
// dimension text as content. A flat placeholder compresses to almost nothing for its pixel count,
// so swap those for a neutral photo tile that still shows where (and how big) a photo goes.
const placeholders = await page.evaluate(async () => {
  const found = new Set();
  for (const el of document.querySelectorAll("*")) {
    if (el.tagName === "IMG" && el.currentSrc) found.add(el.currentSrc);
    const m = getComputedStyle(el).backgroundImage.match(/url\("?([^")]+)"?\)/);
    if (m) found.add(m[1]);
  }
  // Sample a 48×48 thumbnail: a placeholder is mostly one flat, opaque grey (the label text is small).
  const flatGrey = (u) => new Promise((ok) => {
    const i = new Image();
    i.onload = () => {
      if (i.naturalWidth < 150 || i.naturalHeight < 150 || /\.svg/i.test(u)) return ok(false);
      const c = document.createElement("canvas");
      c.width = c.height = 48;
      const x = c.getContext("2d");
      x.drawImage(i, 0, 0, 48, 48);
      let d;
      try { d = x.getImageData(0, 0, 48, 48).data; } catch { return ok(false); }
      const counts = new Map();
      let opaque = 0;
      for (let k = 0; k < d.length; k += 4) {
        if (d[k + 3] < 250) continue;
        opaque++;
        if (Math.abs(d[k] - d[k + 1]) > 6 || Math.abs(d[k + 1] - d[k + 2]) > 6) continue;
        const key = d[k] >> 3;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const top = Math.max(0, ...counts.values());
      ok(opaque > 48 * 48 * 0.9 && top > 48 * 48 * 0.6);
    };
    i.onerror = () => ok(false);
    i.src = u;
  });
  const list = [...found].filter((u) => u.startsWith("file:"));
  const flags = await Promise.all(list.map(flatGrey));
  return list.filter((_, k) => flags[k]);
});
if (placeholders.length) {
  const tile = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6b7684"/><stop offset="1" stop-color="#39414c"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="50%" fill="#c9d0d8" font-family="Arial" font-size="28" letter-spacing="6" text-anchor="middle">PHOTO</text></svg>`);
  await page.evaluate(({ list, tile }) => {
    const set = new Set(list);
    for (const el of document.querySelectorAll("*")) {
      if (el.tagName === "IMG" && set.has(el.currentSrc)) {
        // Pin the rendered size first: the tile has its own aspect ratio, and an auto-height image
        // would otherwise reflow the page and the screenshots would stop matching measured.json.
        const r = el.getBoundingClientRect();
        el.style.width = `${r.width}px`;
        el.style.height = `${r.height}px`;
        el.removeAttribute("srcset");
        el.src = tile;
        el.style.objectFit = "cover";
      }
      const m = getComputedStyle(el).backgroundImage.match(/url\("?([^")]+)"?\)/);
      if (m && set.has(m[1])) { el.style.backgroundImage = `url("${tile}")`; el.style.backgroundSize = "cover"; }
    }
  }, { list: placeholders, tile });
  await page.waitForTimeout(500);
}

// Slice the full page into 1440×1800 JPEGs so each stays legible when the model downsamples it.
const fullH = await page.evaluate(() => document.documentElement.scrollHeight);
const slice = 1800;
let n = 0;
for (let y = 0; y < fullH && n < 6; y += slice) {
  const h = Math.min(slice, fullH - y);
  if (h < 200) break;
  await page.screenshot({ path: join(out, `reference-${++n}.jpg`), type: "jpeg", quality: 82, fullPage: true, clip: { x: 0, y, width: 1440, height: h } });
}
await browser.close();
console.log(`${slug}: ${data.sections.length} sections, page ${data.pageHeight}px, ${placeholders.length} placeholder images masked, ${n} slices → ${out}`);
