import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, ROOT } from "../db.ts";

/**
 * Moc queue — one finished reference design per generation.
 *
 * The old recipe/design-system engines feed the model RULES and FRAGMENTS, which is why every mockup
 * drifted back to the same safe skeleton. The moc queue instead shows the model ONE whole finished
 * homepage design (a "moc") and tells it to clone that exact layout, re-skinned with the lead's brand,
 * logo, photos and facts. Each generation consumes the next moc in the niche's pool and retires it to
 * the "gutter" (the used list); the next generation pulls the next moc. When every moc in a niche has
 * been used the gutter is reset and rotation wraps around, so it never runs dry — keep topping up the
 * pool to add variety.
 *
 * Mocs live in design-library/<niche>/mocs/*.{webp,jpg,jpeg,png,avif}. As with the rest of the design
 * library, a copy in the data dir (<STUDIO_DATA>/design-library/<niche>/mocs) overrides the one shipped
 * in the repo, so an installed build can add mocs without a rebuild. The per-niche gutter is persisted
 * in <STUDIO_DATA>/moc-usage.json.
 */

export interface MocNiche { slug: string; label: string; match: string }

// Matched most-hits-wins (see pickMocNiche), so order is cosmetic; `general` is the catch-all and is
// only used as a fallback, never keyword-matched. Keep patterns reasonably disjoint between niches.
export const MOC_NICHES: MocNiche[] = [
  { slug: "hvac", label: "HVAC", match: "hvac|air.?con|airco|a/c\\b|furnace|heat.?pump|heating.?(and|&).?cooling|cooling|ac.?(repair|install)|climate.?control|boiler|refrigerat|ventilat" },
  { slug: "plumbing", label: "Plumbing", match: "plumb|loodgieter|\\bdrain|sewer|riool|leak.?(detect|repair)|water.?heater|repipe|rooter|faucet|sump.?pump|backflow" },
  { slug: "electrician", label: "Electrician", match: "electric|elektr|wiring|rewir|panel.?upgrade|ev.?charger|generator.?install|lighting.?install" },
  { slug: "roofing", label: "Roofing", match: "roof|\\bdak\\b|re.?roof|shingle|gutter|soffit|fascia|flat.?roof|metal.?roof" },
  { slug: "construction", label: "Construction / remodeling", match: "construct|general.?contractor|remodel|renovat|verbouw|home.?build|custom.?home|home.?addition|basement.?finish|(kitchen|bathroom).?remodel|\\bbouw|aannem|design.?build" },
  { slug: "landscaping", label: "Landscaping", match: "landscap|lawn.?(care|maintenance)|hardscap|garden|\\btuin|hovenier|irrigation|sprinkler|tree.?(service|removal|trim)|arborist|\\bsod\\b|turf|paver|patio|outdoor.?living|snow.?removal" },
  { slug: "painting", label: "Painting", match: "\\bpaint|schilder|house.?painter|(interior|exterior).?paint|cabinet.?refinish|drywall|stucco" },
  { slug: "cleaning", label: "Cleaning", match: "cleaning|cleaner|\\bmaid|janitor|housekeep|schoonmaak|carpet.?clean|window.?clean|(pressure|power|soft).?wash|move.?out.?clean|commercial.?clean" },
  { slug: "pest-control", label: "Pest control", match: "\\bpest|exterminat|termite|rodent|bed.?bug|ongedierte|mosquito|wildlife.?removal|fumigat" },
  { slug: "flooring", label: "Flooring", match: "floor|flooring|vloer|carpet|tapijt|\\btile|tiling|tegel|epoxy|hardwood|laminate|vinyl|\\blvp\\b|parquet|resin.?floor|floor.?coating" },
  { slug: "auto-repair", label: "Auto repair", match: "auto.?repair|mechanic|car.?repair|body.?shop|collision|detailing|car.?detail|\\btire|brake|oil.?change|transmission|autoschade|\\bapk\\b|\\bmot\\b|windshield|auto.?glass" },
  { slug: "dental", label: "Dental", match: "dental|dentist|dentistry|tandarts|orthodont|invisalign|implant|\\bteeth|\\btooth|smile|endodont|periodont" },
  { slug: "medical", label: "Medical / clinics", match: "clinic|kliniek|medical.?(centre|center|practice)|physio|fysio|physical.?therap|chiropract|chiro\\b|spine|osteopath|podiat|optomet|optician|dermatolog|family.?practice|\\bgp\\b|pediatric|urgent.?care|veterinar|\\bvet\\b|animal.?hospital" },
  { slug: "aesthetics", label: "Aesthetics / beauty", match: "med.?spa|medspa|aesthetic|esthetic|cosmetic|botox|filler|injectable|skin.?(clinic|care)|\\blaser|microneedl|hydrafacial|salon|\\bspa\\b|\\blash|\\bbrow|\\bnail|beauty|barber|\\bwax|tanning|hair.?(salon|stylist)" },
  { slug: "fitness", label: "Fitness", match: "\\bgym\\b|fitness|personal.?train|\\bpt\\b|trainer|boxing|kickbox|\\bmma\\b|martial.?art|crossfit|hyrox|pilates|yoga|bootcamp|sportschool|health.?club|spin.?class" },
  { slug: "legal", label: "Legal", match: "\\blaw\\b|lawyer|attorney|solicitor|barrister|legal|litigat|advocat|advocaat|notar|law.?firm|personal.?injury|divorce|family.?law|criminal.?defen|immigration.?law|estate.?planning|probate" },
  { slug: "real-estate", label: "Real estate", match: "real.?estate|realtor|realty|estate.?agent|makelaar|vastgoed|\\bbroker|mortgage|hypothe|property.?(management|group|investment)|homes?.for.sale|we.buy.houses|letting|landlord" },
  { slug: "coaching", label: "Coaching / consulting", match: "life.?coach|business.?coach|executive.?coach|career.?coach|mindset|mentor|consultan|consulting|advisor|counsel|therap(y|ist)|psycholog|hypno|nutrition|dietit|speaker|keynote|masterclass|coaching" },
  { slug: "agency", label: "Agency / creative", match: "marketing.?agency|digital.?agency|web.?(design|develop)|seo.?agency|branding|creative.?agency|advertising|media.?agency|design.?studio|pr.?agency|social.?media.?(agency|marketing)|growth.?agency|lead.?gen" },
  { slug: "restaurants", label: "Restaurants / food", match: "restaurant|eatery|dining|diner|bistro|brasserie|trattoria|pizzeria|pizza|burger|kebab|grill|steak|sushi|ramen|taco|cafe|caf\\u00e9|coffee|bakery|\\bbar\\b|\\bpub\\b|tapas|food.?truck|catering|takeaway|afhaal" },
  { slug: "events", label: "Events / weddings", match: "wedding|event.?(planner|planning|venue)|photograph|videograph|florist|\\bdj\\b|party.?(rental|planner)|banquet|venue|bridal|photo.?booth|eventbureau" },
  { slug: "interior-design", label: "Interior design", match: "interior.?design|interieur|binnenhuis|home.?decor|home.?stag|furnitur|meubel|kitchen.?design|cabinetry|joinery|decorator|space.?planning|styling" },
  { slug: "saas-tech", label: "SaaS / tech", match: "\\bsaas\\b|software|\\bapp\\b|platform|startup|\\btech\\b|technology|\\bai\\b|machine.?learning|fintech|\\bapi\\b|developer.?tool|b2b.?software|cloud.?(platform|software)|dashboard|\\bcrm\\b|mobile.?app|web.?app" },
  { slug: "ecommerce", label: "E-commerce", match: "ecommerce|e.?commerce|online.?(store|shop)|shopify|webshop|\\bdtc\\b|direct.?to.?consumer|retail|product.?brand|apparel|clothing.?brand|cosmetics.?brand|subscription.?box|marketplace" },
  { slug: "general", label: "General (catch-all)", match: "" },
];

const IMG = /\.(webp|jpe?g|png|avif)$/i;

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

/** The niche whose keywords best match the lead's vertical text; falls back to `general`. */
export function pickMocNiche(text: string): MocNiche {
  let best: MocNiche | null = null;
  let hits = 0;
  for (const n of MOC_NICHES) {
    if (!n.match) continue; // general: fallback only, never matched
    const m = text.match(new RegExp(n.match, "gi"))?.length ?? 0;
    if (m > hits) { hits = m; best = n; }
  }
  return best ?? MOC_NICHES[MOC_NICHES.length - 1];
}

/** Every moc available for a niche, deduped by filename (data dir wins), natural-sorted. */
export function mocFiles(slug: string): { name: string; path: string }[] {
  const seen = new Map<string, string>();
  for (const root of libraryRoots()) {
    const dir = join(root, slug, "mocs");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (IMG.test(f) && !seen.has(f)) seen.set(f, realPath(join(dir, f)));
    }
  }
  return [...seen.entries()]
    .map(([name, path]) => ({ name, path }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

export interface MocPick { niche: string; file: string; path: string }

// ---- gutter (used list) persistence ----
const USAGE_FILE = join(DATA, "moc-usage.json");
type Usage = Record<string, string[]>; // niche slug -> used filenames, in the order they were used

function readUsage(): Usage {
  try { return existsSync(USAGE_FILE) ? (JSON.parse(readFileSync(USAGE_FILE, "utf8")) as Usage) : {}; } catch { return {}; }
}
function writeUsage(u: Usage) {
  try { mkdirSync(DATA, { recursive: true }); writeFileSync(USAGE_FILE, JSON.stringify(u, null, 2)); } catch { /* best effort */ }
}

/**
 * Take the next unused moc for a niche and move it to the gutter. Recycles (resets the gutter and
 * starts over from the first moc) once every moc has been used. Returns null if the niche has no mocs.
 */
export function nextMoc(slug: string): MocPick | null {
  const files = mocFiles(slug);
  if (!files.length) return null;
  const usage = readUsage();
  let used = usage[slug] ?? [];
  let avail = files.filter((f) => !used.includes(f.name));
  if (!avail.length) { used = []; avail = files; } // all used -> recycle (wrap around)
  const pick = avail[0];
  usage[slug] = [...used, pick.name];
  writeUsage(usage);
  return { niche: slug, file: pick.name, path: pick.path };
}

/**
 * The next moc for a business, by its vertical text: the matched niche's pool first, then the
 * `general` pool as a fallback when the matched niche has no mocs yet. Null when no mocs exist at all.
 */
export function nextMocFor(text: string): MocPick | null {
  const n = pickMocNiche(text);
  return nextMoc(n.slug) ?? (n.slug !== "general" ? nextMoc("general") : null);
}

/** Re-resolve an already chosen moc (for an amend / gate retry) without advancing the gutter. */
export function resolveMoc(slug: string, file: string): MocPick | null {
  if (!slug || !file) return null;
  const found = mocFiles(slug).find((f) => f.name === file);
  return found ? { niche: slug, file, path: found.path } : null;
}
