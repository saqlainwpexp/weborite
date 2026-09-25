import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, ROOT } from "../db.ts";

/**
 * The design library: professional reference systems (extracted from real designer templates) that
 * steer mockup generation so the output looks designed, not AI-generic. Each folder under
 * design-library/ has a design-system.json (fonts, type scale, colours, spacing, components,
 * section layouts) and a reference.png. We match a lead to the closest system and feed that system
 * plus its reference image into the generation prompt — while the lead keeps its own brand colour,
 * logo and real photos.
 */

export interface DesignSystem {
  slug: string;
  dir: string;
  name: string;
  character: string;
  reuse: string;
  referenceImage: string | null; // absolute path
  /** The page, top to bottom, as ordered slices (reference-1.jpg, reference-2.jpg…) when the system was measured from a real template. */
  referenceImages: string[];
  /** "measured" = numbers computed from a real template's rendered CSS (scripts/extract-template.mjs); otherwise hand-synthesized. */
  measured: boolean;
  json: unknown; // the full spec, injected into the prompt
}

/** Prefer a user-editable library in the data folder; fall back to the one shipped with the project. */
function libraryDir(): string | null {
  for (const d of [join(DATA, "design-library"), join(ROOT, "design-library")]) {
    if (existsSync(d)) return d;
  }
  return null;
}

/**
 * In the packaged app the library ships inside app.asar but is asarUnpack'd, so the real files live
 * under app.asar.unpacked. Reference images are handed to the (external) Claude CLI as a path, which
 * can't read inside the archive — so return the real unpacked path.
 */
function realPath(p: string): string {
  if (/app\.asar[\\/]/.test(p) && !p.includes("app.asar.unpacked")) {
    const u = p.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
    if (existsSync(u)) return u;
  }
  return p;
}

export function listDesignSystems(): DesignSystem[] {
  const base = libraryDir();
  if (!base) return [];
  const out: DesignSystem[] = [];
  for (const slug of readdirSync(base)) {
    const dir = join(base, slug);
    const specPath = join(dir, "design-system.json");
    if (!existsSync(specPath)) continue;
    try {
      const json = JSON.parse(readFileSync(specPath, "utf8")) as { name?: string; character?: string; reuse?: string; tier?: string };
      const slices = readdirSync(dir).filter((f) => /^reference-\d+\.(png|jpe?g|webp)$/i.test(f)).sort((a, b) => parseInt(a.slice(10)) - parseInt(b.slice(10))).map((f) => realPath(join(dir, f)));
      const ref = ["reference.png", "reference.webp", "reference.jpg", "ref.png"].map((f) => join(dir, f)).find(existsSync)
        ?? readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f) && !/^spec-/i.test(f)).sort((a, b) => parseInt(a) - parseInt(b)).map((f) => join(dir, f))[0]
        ?? null;
      out.push({ slug, dir, name: json.name ?? slug, character: json.character ?? "", reuse: json.reuse ?? "", referenceImage: slices[0] ?? (ref ? realPath(ref) : null), referenceImages: slices, measured: json.tier === "measured", json });
    } catch {
      /* skip a malformed spec */
    }
  }
  return out;
}

const STOP = new Set(["the", "a", "and", "or", "for", "with", "that", "this", "best", "reference", "leads", "lead", "brand", "brands", "own", "use", "take", "swap", "colour", "color", "system", "systems", "into", "put", "slot", "keep", "look", "feel", "site", "sites", "website", "homepage"]);
const words = (s: string) => (s.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !STOP.has(w));

// When nothing matches a lead's niche, prefer a clean, light, broadly-applicable system over a
// bold or dark one (a dark software template on a local bakery is worse than a neutral clean one).
const VERSATILE = new Set(["clean", "modern", "professional", "corporate", "service", "services", "business", "startup", "trust", "trustworthy", "established", "friendly", "versatile", "light", "any"]);

function score(s: DesignSystem, need: Set<string>): number {
  let n = 0;
  // Distinct words only: a spec that repeats "HVAC" five times isn't a five-times better fit.
  for (const w of new Set(words(`${s.name} ${s.character} ${s.reuse}`))) if (need.has(w)) n++;
  return n;
}

/** Stable small number from a string, so the same lead always gets the same pick. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Pick the design system whose niche keywords best overlap the lead's vertical. Systems measured from
 * real templates win over hand-synthesized ones, and when several fit equally well the lead's id
 * rotates between them — so five HVAC leads don't all come out as the same template. When nothing
 * matches, fall back to the most versatile clean system rather than an arbitrary (possibly wrong) one.
 * Deterministic and cheap; returns null only when the library is empty.
 */
export function pickDesignSystem(vertical: { label?: string; register?: string; key?: string } | null, seed = ""): DesignSystem | null {
  const systems = listDesignSystems();
  if (!systems.length) return null;
  const need = new Set([...words(vertical?.label ?? ""), ...words(vertical?.register ?? ""), ...words(vertical?.key ?? "")]);

  const rotate = (pool: DesignSystem[]) => pool.sort((a, b) => a.slug.localeCompare(b.slug))[hash(seed) % pool.length];
  if (need.size) {
    const scored = systems.map((s) => ({ s, sc: score(s, need) })).filter((x) => x.sc >= 1);
    if (scored.length) {
      // Measured systems carry exact spacing and full-page references: prefer them whenever one fits at all.
      const measured = scored.filter((x) => x.s.measured);
      const pool = measured.length ? measured : scored;
      const top = Math.max(...pool.map((x) => x.sc));
      // Keyword counts depend on how wordy each spec is, so anything scoring at least half the best is a
      // real fit; rotate among those.
      return rotate(pool.filter((x) => x.sc * 2 >= top).map((x) => x.s));
    }
  }

  // No niche overlap: choose the most broadly-applicable clean system.
  let fallback = systems[0];
  let fbScore = -1;
  for (const s of systems) { const sc = score(s, VERSATILE); if (sc > fbScore) { fbScore = sc; fallback = s; } }
  return fallback;
}

/** A compact catalog line per system, for prompts or a picker UI. */
export function designCatalog(): { slug: string; name: string; character: string }[] {
  return listDesignSystems().map((s) => ({ slug: s.slug, name: s.name, character: s.character }));
}
