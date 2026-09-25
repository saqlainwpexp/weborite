import type { Page } from "playwright";

export interface LayoutFinding {
  id: "desktop-overflow" | "text-overlap" | "covered-text" | "off-column";
  detail: string;
}

/**
 * Desktop layout problems a screenshot reviewer catches instantly but the other checks don't:
 * sideways scroll, text colliding with text (a logo running into the nav), text hidden under another
 * block (a heading under a form), and content that ignores the page's single content column.
 * Runs at the page's current viewport width; scrolls through the page itself.
 */
export async function layoutChecks(page: Page): Promise<LayoutFinding[]> {
  return page.evaluate(() => {
    const out: { id: "desktop-overflow" | "text-overlap" | "covered-text" | "off-column"; detail: string }[] = [];
    const W = window.innerWidth;
    const snip = (s: string) => `"${s.replace(/\s+/g, " ").trim().slice(0, 40)}"`;

    // 1. Sideways scroll at desktop width.
    const sw = document.documentElement.scrollWidth;
    if (sw > W + 2) {
      const culprit = [...document.querySelectorAll<HTMLElement>("body *")].find((e) => {
        const r = e.getBoundingClientRect();
        return r.right > W + 2 && r.width > 0 && getComputedStyle(e).position !== "fixed";
      });
      out.push({ id: "desktop-overflow", detail: `Page is ${sw}px wide at ${W}px${culprit ? ` (${culprit.tagName.toLowerCase()}.${String(culprit.className).split(" ")[0]} sticks out)` : ""}` });
    }

    // Visible text runs, as page-coordinate boxes (one per rendered line).
    const hidden = (el: Element) => {
      // Answers inside a closed <details> aren't rendered, whatever their boxes say.
      // Decorative type (watermark numerals, outlined backdrop words) may bleed or clip on purpose.
      if (el.closest("[aria-hidden='true']")) return true;
      const cs = getComputedStyle(el);
      const alpha = +(cs.color.match(/rgba\([^)]*,\s*([\d.]+)\)/)?.[1] ?? 1);
      if (alpha < 0.35 || (parseFloat(cs.webkitTextStrokeWidth) > 0 && /rgba\(0, 0, 0, 0\)|transparent/.test(cs.webkitTextFillColor))) return true;
      const d = el.closest("details");
      if (d && !d.open && !el.closest("summary")) return true;
      for (let e: Element | null = el; e; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.display === "none" || s.visibility === "hidden" || +s.opacity < 0.05) return true;
        // Closed mobile menus, off-canvas panels, screen-reader-only text.
        if (s.position === "fixed" && e !== document.body) return true;
      }
      return false;
    };
    const runs: { el: HTMLElement; text: string; boxes: DOMRect[] }[] = [];
    const cut: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent || "").trim();
      const el = n.parentElement;
      if (text.length < 2 || !el || /^(SCRIPT|STYLE|NOSCRIPT|OPTION|TEXTAREA)$/.test(el.tagName) || hidden(el)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      // Drop lines clipped away by an overflow:hidden ancestor (a logo ticker's off-screen half) —
      // the browser still reports their boxes.
      const clips = [] as DOMRect[];
      for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) if (getComputedStyle(e).overflowX !== "visible") clips.push(e.getBoundingClientRect());
      const inside = (r: DOMRect, c: DOMRect) => r.left >= c.left - 1 && r.right <= c.right + 1;
      const outside = (r: DOMRect, c: DOMRect) => r.right <= c.left + 1 || r.left >= c.right - 1;
      const rects = [...range.getClientRects()]
        // Off-screen on purpose (skip links, visually-hidden labels) is not a layout bug.
        .filter((r) => r.width > 2 && r.height > 4 && r.right > 0 && r.left < W && !clips.some((c) => outside(r, c)));
      // Half-hidden by its own container: the words are literally cut off.
      if (rects.some((r) => !clips.every((c) => inside(r, c))) && cut.length < 4) cut.push(snip(text));
      const boxes = rects.filter((r) => clips.every((c) => inside(r, c))).map((r) => new DOMRect(r.left + scrollX, r.top + scrollY, r.width, r.height));
      if (boxes.length) runs.push({ el, text, boxes });
    }

    // 2. Text drawn on top of other text.
    const hits: string[] = [];
    for (let i = 0; i < runs.length && hits.length < 4; i++) {
      for (let j = i + 1; j < runs.length && hits.length < 4; j++) {
        const a = runs[i], b = runs[j];
        if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
        for (const x of a.boxes) for (const y of b.boxes) {
          // Compare glyph cores (middle 60% of each line box): tight leading on big numbers makes
          // neighbouring line boxes touch without the letters ever colliding.
          const core = (r: DOMRect) => ({ l: r.left, r: r.right, t: r.top + r.height * 0.2, b: r.bottom - r.height * 0.2 });
          const [p, q] = [core(x), core(y)];
          const ix = Math.min(p.r, q.r) - Math.max(p.l, q.l);
          const iy = Math.min(p.b, q.b) - Math.max(p.t, q.t);
          if (ix > 4 && iy > 2 && ix * iy > 0.15 * Math.min((p.r - p.l) * (p.b - p.t), (q.r - q.l) * (q.b - q.t))) {
            hits.push(`${snip(a.text)} runs into ${snip(b.text)}`);
            break;
          }
        }
      }
    }
    if (hits.length) out.push({ id: "text-overlap", detail: hits.join("; ") });

    // 3. Text hidden underneath another element (a heading under a form, copy under a photo).
    const pinned = (el: Element | null) => {
      for (let e = el; e; e = e.parentElement) if (/fixed|sticky/.test(getComputedStyle(e).position)) return true;
      return false;
    };
    const covered: string[] = [];
    for (const r of runs) {
      if (covered.length >= 4) break;
      // Probe a few points along the first lines: text half-tucked under a panel is still broken.
      let blocker: Element | null = null;
      for (const box of r.boxes.slice(0, 3)) {
        const cy = box.top + box.height / 2;
        window.scrollTo(0, Math.max(0, cy - innerHeight / 2));
        for (const f of [0.1, 0.5, 0.9]) {
          const top = document.elementFromPoint(box.left + box.width * f - scrollX, cy - scrollY);
          if (!top || top === r.el || r.el.contains(top) || top.contains(r.el) || pinned(top)) continue;
          // Transparent wrappers (a label over an <a>) are fine when they sit in the same component.
          const wrap = top.closest("a, button, label");
          if (wrap && wrap.contains(r.el)) continue;
          blocker = top;
          break;
        }
        if (blocker) break;
      }
      if (blocker) covered.push(`${snip(r.text)} is hidden under <${blocker.tagName.toLowerCase()}${blocker.className ? "." + String(blocker.className).split(" ")[0] : ""}>`);
    }
    window.scrollTo(0, 0);
    covered.push(...cut.map((t) => `${t} is cut off by its container`));
    if (covered.length) out.push({ id: "covered-text", detail: covered.slice(0, 5).join("; ") });

    // 4. One content column: the most common left edge of text is the column; text (and the header
    //    logo) must stay inside [left, W - left]. Catches a wider header, off-grid blocks and huge
    //    empty left gutters.
    const lefts = new Map<number, number>();
    for (const r of runs) for (const b of r.boxes) if (b.width < W * 0.8) { const k = Math.round(b.left / 8) * 8; lefts.set(k, (lefts.get(k) || 0) + 1); }
    const col = [...lefts.entries()].filter(([k]) => k >= 16 && k < W / 3).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (col !== undefined) {
      const tol = 24;
      const stray: string[] = [];
      const logo = document.querySelector<HTMLElement>("header img, header svg, [class*='logo' i] img");
      const items: { label: string; left: number; right: number }[] = runs.map((r) => ({ label: snip(r.text), left: Math.min(...r.boxes.map((b) => b.left)), right: Math.max(...r.boxes.map((b) => b.right)) }));
      if (logo) { const b = logo.getBoundingClientRect(); items.push({ label: "the header logo", left: b.left + scrollX, right: b.right + scrollX }); }
      for (const it of items) {
        if (stray.length >= 4) break;
        if (it.left < col - tol) stray.push(`${it.label} starts at ${Math.round(it.left)}px`);
        else if (it.right > W - col + tol) stray.push(`${it.label} ends at ${Math.round(it.right)}px`);
      }
      if (stray.length) out.push({ id: "off-column", detail: `Content column is ${col}px–${W - col}px, but ${stray.join("; ")}` });
    }
    return out;
  });
}
