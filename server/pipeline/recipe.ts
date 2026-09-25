import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, LEADS_DIR, ROOT, leadDir } from "../db.ts";

/**
 * Design recipes: why two leads never get the same page.
 *
 * A niche library (design-library/<niche>/library.json) holds base STYLES (fonts, colours, spacing,
 * buttons) and many SECTION variants (a hero from one template, an about from another, a reservation
 * block from a third), each with a cropped reference image. A recipe = one style + a page order +
 * one variant per section. Every recipe used is saved in <lead>/recipes.json; a new recipe is chosen
 * to be as far as possible from every recipe already used in that niche — and never equal to any of
 * this lead's own earlier recipes, so pressing "regenerate" always produces a new design.
 */

interface LibStyle {
  id: string;
  name?: string;
  fits: string;
  character?: string;
  fonts?: string;
  cssStarter?: string;
  /** Trades styles point at a measured design system folder instead of inlining their tokens. */
  system?: string;
}
interface LibSection { id: string; role: string; from: string; spec: string }
interface Library { niche: string; match: string; styles: LibStyle[]; orders: string[][]; sections: LibSection[] }

export interface Niche { slug: string; dir: string; lib: Library }

export interface RecipeSection { role: string; id: string; from: string; spec: string; image: string | null }
export interface Recipe {
  niche: string;
  style: { id: string; name: string; character: string; fonts?: string; tokens: unknown };
  sections: RecipeSection[];
}

interface Saved { niche: string; style: string; order: string[]; sections: string[]; at: string }

function libraryRoots(): string[] {
  return [join(DATA, "design-library"), join(ROOT, "design-library")].filter(existsSync);
}

/** Packaged app: files an external process reads must come from app.asar.unpacked. */
function realPath(p: string): string {
  if (/app\.asar[\\/]/.test(p) && !p.includes("app.asar.unpacked")) {
    const u = p.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
    if (existsSync(u)) return u;
  }
  return p;
}

export function listNiches(): Niche[] {
  const seen = new Set<string>();
  const out: Niche[] = [];
  for (const root of libraryRoots()) {
    for (const slug of readdirSync(root)) {
      const file = join(root, slug, "library.json");
      if (seen.has(slug) || !existsSync(file)) continue;
      try {
        out.push({ slug, dir: join(root, slug), lib: JSON.parse(readFileSync(file, "utf8")) as Library });
        seen.add(slug);
      } catch {
        /* malformed library: skip */
      }
    }
  }
  return out;
}

/** The niche whose keywords best match the lead's vertical text, or null. */
export function pickNiche(text: string): Niche | null {
  let best: Niche | null = null;
  let hits = 0;
  for (const n of listNiches()) {
    const m = text.match(new RegExp(n.lib.match, "gi"))?.length ?? 0;
    if (m > hits) { hits = m; best = n; }
  }
  return best;
}

// Small seeded PRNG so a lead's recipe is reproducible until it is regenerated.
function rng(seedText: string) {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) h = Math.imul(h ^ seedText.charCodeAt(i), 16777619);
  let s = h >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function readSaved(leadId: string): Saved[] {
  const f = join(leadDir(leadId), "recipes.json");
  try { return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Saved[]) : []; } catch { return []; }
}

function allSaved(niche: string, except: string): Saved[] {
  if (!existsSync(LEADS_DIR)) return [];
  return readdirSync(LEADS_DIR).filter((id) => id !== except).flatMap((id) => readSaved(id)).filter((r) => r.niche === niche);
}

/** How different two recipes are: each section variant not shared counts 1, a different style 2, a different order 1. */
function distance(a: Saved, b: Saved) {
  const shared = a.sections.filter((s) => b.sections.includes(s)).length;
  return (a.sections.length - shared) + (a.style === b.style ? 0 : 2) + (a.order.join() === b.order.join() ? 0 : 1);
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{3,}/g) ?? []);

/**
 * Choose (and record) a new recipe for this lead. `vertical` is free text about the business
 * (category label, register, site title) used to weight styles that suit it.
 */
export function newRecipe(leadId: string, niche: Niche, vertical: string): Recipe {
  const { lib } = niche;
  const mine = readSaved(leadId);
  const others = allSaved(niche.slug, leadId);
  const rand = rng(`${leadId}:${mine.length}`);
  const pickOne = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

  // Styles that suit the business: anything scoring at least half of the best keyword overlap.
  const need = words(vertical);
  const fit = lib.styles.map((s) => ({ s, n: [...words(s.fits)].filter((w) => need.has(w)).length }));
  const top = Math.max(0, ...fit.map((f) => f.n));
  const styles = top > 0 ? fit.filter((f) => f.n * 2 >= top).map((f) => f.s) : lib.styles;

  let best: { saved: Saved; score: number } | null = null;
  for (let i = 0; i < 400; i++) {
    const style = pickOne(styles);
    const order = pickOne(lib.orders);
    const chosen: LibSection[] = [];
    for (const role of order) {
      const variants = lib.sections.filter((s) => s.role === role);
      if (variants.length) chosen.push(pickOne(variants));
    }
    const sources = new Set(chosen.map((s) => s.from));
    if (sources.size < Math.min(3, chosen.length)) continue; // a real mix, not one template in disguise
    const saved: Saved = { niche: niche.slug, style: style.id, order, sections: chosen.map((s) => s.id), at: new Date().toISOString() };
    // Must change a lot from this lead's own earlier designs; otherwise, be far from everyone's.
    const ownMin = Math.min(99, ...mine.map((m) => distance(saved, m)));
    if (ownMin < 4) continue;
    const othersMin = Math.min(99, ...others.map((o) => distance(saved, o)));
    const score = Math.min(ownMin, othersMin) * 10 + sources.size;
    if (!best || score > best.score) best = { saved, score };
  }
  if (!best) throw new Error(`No new ${lib.niche} recipe left for this lead`);

  writeFileSync(join(leadDir(leadId), "recipes.json"), JSON.stringify([...mine, best.saved], null, 1));
  return materialise(niche, best.saved);
}

/** The lead's most recent recipe (a gate retry fixes that design rather than starting a new one). */
export function currentRecipe(leadId: string, niche: Niche): Recipe | null {
  const last = readSaved(leadId).filter((r) => r.niche === niche.slug).pop();
  if (!last || !niche.lib.styles.some((s) => s.id === last.style)) return null;
  return materialise(niche, { ...last, sections: last.sections.filter((id) => niche.lib.sections.some((s) => s.id === id)) });
}

function materialise(niche: Niche, saved: Saved): Recipe {
  const style = niche.lib.styles.find((s) => s.id === saved.style)!;
  let tokens: unknown = { fonts: style.fonts, cssStarter: style.cssStarter };
  let name = style.name ?? style.id;
  let character = style.character ?? "";
  if (style.system) {
    for (const root of libraryRoots()) {
      const f = join(root, style.system, "design-system.json");
      if (!existsSync(f)) continue;
      const ds = JSON.parse(readFileSync(f, "utf8")) as { name: string; character: string; cssStarter: string; typography: unknown; color: unknown; spacing: unknown; components: { button?: unknown } };
      name = ds.name;
      character = ds.character;
      tokens = { cssStarter: ds.cssStarter, typography: ds.typography, color: ds.color, spacing: ds.spacing, button: ds.components?.button };
      break;
    }
  }
  const sections = saved.sections.map((id) => {
    const s = niche.lib.sections.find((x) => x.id === id)!;
    const img = join(niche.dir, "sections", `${id}.jpg`);
    return { role: s.role, id, from: s.from, spec: s.spec, image: existsSync(img) ? realPath(img) : null };
  });
  return { niche: niche.lib.niche, style: { id: style.id, name, character, fonts: style.fonts, tokens }, sections };
}
