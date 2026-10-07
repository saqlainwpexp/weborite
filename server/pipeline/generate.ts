import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { agencyProfileBlock, leadDir, listFeedbackNotes, readJson, writeJson } from "../db.ts";
import { extractHtml, runClaude } from "../claude/runner.ts";
import { pickDesignSystem } from "./designLibrary.ts";
import { assetSheet, stockPhotos, trimPadding } from "./assets.ts";
import { currentRecipe, newRecipe, pickNiche } from "./recipe.ts";
import { nextMocFor, resolveMoc } from "./mocs.ts";
import type { BenchmarkSet, Capture, Diagnosis, Fact, GateCheck } from "../../shared/types.ts";

export const SYSTEM = `You are a senior web designer and front-end engineer. You rebuild small-business homepages so they compete visually with the best sites in their category, and you write clean, semantic, responsive HTML and CSS by hand.

Non-negotiable rules:
1. The brand colours and the logo are fixed inputs. Use them exactly as given. Don't recolour, restyle or redraw the logo, and don't add new brand hues. You may use neutrals (white, off-whites, greys, near-black) and tints or shades of the brand colours for surfaces.
2. The designated strongest asset must appear prominently, normally as the hero. If it's a video, it stays a video (<video autoplay muted loop playsinline> with its poster, or the original embed). Never swap it for a still image or a stock substitute.
3. No invented facts. Every number, rating, review count, year, award, client name, testimonial, address and phone number must be copied verbatim from the FACTS list. If a fact you'd like to use isn't there, leave the element out. Never derive new figures, for example by counting listed locations or computing years in business. A number must appear verbatim in FACTS. Don't use placeholder text, lorem ipsum, "Your Company", example.com, or stock image URLs.
4. Use only the local asset paths provided. Google Fonts is the only permitted external resource. Every font family must be a Google Fonts family loaded with a <link> from fonts.googleapis.com (for example Inter, Source Serif 4, Libre Caslon Text, DM Sans). Never make a system font (Helvetica Neue, Iowan Old Style, Georgia, Arial, -apple-system, Segoe UI…) the primary family; generic fallbacks after the Google family are fine. The site will later be rebuilt in WordPress/Elementor, which can only load Google Fonts.
5. Every class used in the HTML must be defined in your CSS. Text must reach WCAG AA contrast (4.5:1 for body text, 3:1 for text 24px and larger).
6. Mobile first. It must work at 375px with no sideways scroll. The mobile nav must open and close (a small inline script or a checkbox/details pattern). Tap targets must be at least 44px. No element may scroll sideways, including the nav row. Use one primary call-to-action style and don't repeat the same button twice in the header.

Design standard: distinctive, confident and specific to this business. Use generous whitespace, a clear typographic hierarchy, one primary call to action, and trust signals near the top (only real ones from the FACTS list). Avoid generic AI-template patterns such as purple gradients, emoji icons, three identical feature cards with icons, or glassmorphism.`;

function contrast(a: string, b: string) {
  const lum = (h: string) => {
    const n = parseInt(h.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
}

/** Pre-computed contrast so Claude pairs text and brand colours correctly the first time. */
function contrastNotes(brand: Diagnosis["brand"]) {
  return Object.entries(brand)
    .filter(([k, v]) => v && k !== "text" && k !== "background")
    .map(([k, v]) => {
      const w = contrast("#ffffff", v as string);
      const d = contrast("#111111", v as string);
      const onBg = contrast(v as string, brand.background);
      return `- ${k} ${v}: white text ${w}:1${w < 4.5 ? " (fails for body/button text; only OK for text 24px and up if ≥3)" : ""}, near-black text ${d}:1, as text on the page background ${onBg}:1${onBg < 4.5 ? " (fails for small text)" : ""}`;
    })
    .join("\n");
}

export function buildFactsBlock(facts: Fact[]) {
  const out: string[] = [];
  let size = 0;
  for (const f of facts) {
    const line = `- ${f.text}`;
    if (size + line.length > 28000) break;
    out.push(line);
    size += line.length;
  }
  return out.join("\n");
}

export async function generateMockup(
  leadId: string,
  input: { capture: Capture; diagnosis: Diagnosis; facts: Fact[]; benchmarks: BenchmarkSet | null; business: string; scratch?: boolean },
  opts?: { failures?: GateCheck[]; changes?: string },
) {
  // A sameness failure means the layout was a near-clone of another lead's — that can only be fixed
  // by a DIFFERENT design, so we re-pick rather than amend. Other gate retries and human change
  // requests edit the EXISTING mockup (same recipe) instead of starting over.
  const sameness = Boolean(opts?.failures?.some((f) => /^Distinct from other mockups/.test(f.name)));
  const amend = Boolean((opts?.failures?.length && !sameness) || opts?.changes);
  const prevPick = readJson<{ niche?: string; style?: string; system?: string; mocNiche?: string; moc?: string }>(leadId, "design.json") ?? null;
  const dir = leadDir(leadId);
  const outDir = join(dir, "mockup");
  mkdirSync(outDir, { recursive: true });
  const { capture, diagnosis, facts, benchmarks } = input;
  const rel = (p: string) => (/^https?:/.test(p) ? p : `../${p}`);
  const sa = diagnosis.strongestAsset;
  const poster = sa?.kind === "video" ? capture.assets.find((a) => a.kind === "image" && a.area === 0)?.path : undefined;

  const locked = {
    brandColors: diagnosis.brand,
    logo: capture.logo ? { src: rel(capture.logo.path), width: capture.logo.width, height: capture.logo.height } : "No logo file found. Set the business name as a text wordmark in the brand primary colour.",
    strongestAsset: sa ? { src: rel(sa.path), kind: sa.kind, poster: poster ? rel(poster) : undefined, why: sa.reason } : null,
  };
  // Tight crops of padded logos/badges (see trimPadding) replace the originals everywhere below.
  const trimmed = await trimPadding(leadId, capture);
  const otherAssets = capture.assets
    .filter((a) => a.path !== sa?.path)
    // The original file name often says what the image is ("lg-logo.png", "kiwa-keurmerk.jpg").
    .map((a) => ({ src: rel(trimmed[a.path] ?? a.path), kind: a.kind, size: a.width && a.height && !trimmed[a.path] ? `${a.width}x${a.height}` : undefined, from: a.sourceUrl ? decodeURIComponent(basename(a.sourceUrl.split("?")[0])).slice(0, 60) : undefined }));

  // Let the generator SEE what each image is, and give it relevant stock photos for slots the lead's
  // own images can't fill — so it never forces a partner logo or certificate into a photo slot.
  const sheet = await assetSheet(leadId, capture, trimmed);
  const verticalText = [benchmarks?.label, benchmarks?.vertical, benchmarks?.register, capture.title, capture.description].filter(Boolean).join(" ");
  const stock = await stockPhotos(leadId, verticalText);

  // MOC QUEUE (preferred): show the model ONE finished reference design and have it clone that exact
  // layout, re-skinned for this lead — the fix for "every niche gets the same template". On an amend
  // or a (non-sameness) gate retry we keep the same moc so edits refine that design; a fresh run or a
  // sameness re-pick advances to the next moc in the niche's pool (recycling once all are used). When
  // a niche has no mocs uploaded yet, moc is null and we fall back to the recipe / design-system path.
  const moc = amend ? resolveMoc(prevPick?.mocNiche ?? "", prevPick?.moc ?? "") : nextMocFor(verticalText);

  // Niches with a section library get a unique RECIPE (base style + sections mixed from different
  // designs), so no two leads — and no two regenerations of one lead — share a layout. A gate retry
  // keeps the recipe it is fixing. Other niches fall back to the closest single design system.
  const niche = moc ? null : pickNiche(verticalText);
  // On a sameness retry, force a fresh mix (newRecipe already stays far from this lead's and others'
  // recipes); otherwise keep the current recipe for an amend, or make a new one.
  const recipe = niche ? ((amend ? currentRecipe(leadId, niche) : null) ?? newRecipe(leadId, niche, verticalText)) : null;
  // No moc and no niche library: pick a measured/clean system. A sameness retry rotates to a different
  // one and avoids the template we just used.
  const dsSeed = sameness ? `${leadId}:redo:${prevPick?.system ?? ""}` : leadId;
  const ds = (moc || recipe) ? null : pickDesignSystem(
    benchmarks ? { label: benchmarks.label, register: benchmarks.register, key: benchmarks.vertical } : null,
    dsSeed,
    sameness && prevPick?.system ? [prevPick.system] : [],
  );
  // Remember what was chosen so a later amend can reuse it / a sameness retry can avoid it.
  writeJson(leadId, "design.json", moc ? { mocNiche: moc.niche, moc: moc.file } : recipe ? { niche: recipe.niche, style: recipe.style.id } : { system: ds?.slug });

  // Learned preferences: corrections the owner gave on earlier mockups, so they don't have to be
  // repeated. Favour notes from the same vertical, then fill with recent ones from any vertical.
  const learned = (() => {
    const notes = listFeedbackNotes();
    if (!notes.length) return "";
    const vkey = benchmarks?.vertical ?? null;
    const mine = vkey ? notes.filter((n) => n.vertical === vkey) : [];
    const pick = [...mine].reverse().slice(0, 6);
    for (const n of [...notes].reverse()) { if (pick.length >= 8) break; if (!pick.includes(n)) pick.push(n); }
    const lines = pick.map((n) => `- ${n.text.replace(/\s+/g, " ").trim().slice(0, 240)}`).join("\n");
    return `

LEARNED PREFERENCES — the agency gave this feedback on earlier mockups. Honour every point that could apply here, so the same corrections never have to be made again:
${lines}`;
  })();

  const images = [join(dir, "desktop-fold.jpg"), join(dir, "mobile.jpg")].filter(existsSync);
  if (sheet) images.push(sheet);
  // A moc brings the one finished design to clone; a recipe brings one cropped reference per section;
  // a measured system brings the template's page top to bottom (first three slices).
  const refs = moc
    ? [moc.path].filter(existsSync)
    : recipe
    ? recipe.sections.map((s) => s.image).filter((p): p is string => Boolean(p && existsSync(p)))
    : ds ? (ds.referenceImages.length ? ds.referenceImages.slice(0, 3) : ds.referenceImage ? [ds.referenceImage] : []).filter(existsSync) : [];
  images.push(...refs);

  const scratch = Boolean(input.scratch);
  let prompt = (scratch
    ? `Design the first website homepage for "${input.business || capture.title}", a ${capture.description.length < 60 ? capture.description : "local business"} that has no website today. Customers only find its Google Maps listing (${capture.finalUrl}).
The brand colours below were chosen for this business (it has no existing brand); treat them as fixed. The photos are the business's own, from its listing.
Include the ways people actually act: call (tel: link), get directions (link to the Google Maps listing above), and opening hours if they are in FACTS. Google reviews in FACTS may be used as testimonials, quoted verbatim.`
    : `Rebuild the homepage for "${input.business || capture.title}" (${capture.finalUrl}).`) + `
The file will be saved as mockup/index.html inside the lead folder, so asset paths start with ../assets/.`;
  prompt += `

LOCKED INPUTS (use exactly):
${JSON.stringify(locked, null, 2)}

Contrast of the brand colours (fix failures with a darker shade of the same hue for buttons, or with dark text; never swap in a different hue):
${contrastNotes(diagnosis.brand)}

${scratch ? "Fonts: choose Google Fonts that suit the category." : `Existing fonts (you may keep or replace them, since typography is open for improvement): ${capture.fonts.map((f) => `${f.usage}: ${f.family}`).join(", ")}`}

OTHER REAL ASSETS YOU MAY USE:
${JSON.stringify(otherAssets, null, 1)}
${stock.length ? `
STOCK PHOTOS (licensed, already saved locally): use one only for a photo slot none of the lead's own photos fits. Don't add photo credits.
${JSON.stringify(stock.map((p) => ({ src: rel(p.src), subject: p.subject })), null, 1)}
` : ""}
IMAGE RULES (earlier mockups were rejected for breaking these):
- ${sheet ? "The ASSET SHEET attached right after the site screenshots shows every captured image with its path. Look at it before placing anything and" : "Before placing any image,"} decide what each image is: a photo (work, team, van, place, product in use), a brand/partner logo, a certificate or quality mark, or an icon/graphic.
- Photo slots (hero, service cards, about, testimonials, CTA banners, section backgrounds) take only photos whose subject fits that section. Never put a logo, brand graphic, certificate or wordmark in a photo slot or as a background.
- Brand and partner logos appear only in the partners ticker. Certificates and quality marks appear only as small badges (max ~110px tall) in a trust row or next to the claim they support.
- If none of the lead's photos fits a slot, use a stock photo whose subject fits. If nothing fits, redesign that block without an image. Never force an unrelated image in, and don't use the same photo twice.

PARTNERS / BRANDS: when the lead works with brands, show them as a continuously scrolling logo ticker: an overflow:hidden strip with a track that holds the logo set twice and animates translateX(0 → -50%) linearly (~30s, infinite), pauses on hover and stops under prefers-reduced-motion. Logos ~40px tall, greyscale, full colour on hover, generous gaps. Use the captured logo images. If a brand is named in FACTS but no logo image was captured, show its name as a clean typographic wordmark chip in the same ticker. Never draw or invent a logo.

LAYOUT RULES (checked automatically at 1440px and 1280px):
- One content width for the whole page. The top bar, header, hero text, every section and the footer put their content in the same centred container: max-width 1280px, 32px side padding (20px under 768px). Backgrounds and photos may run full-bleed, but text, logo, nav, buttons, cards and forms stay inside that column. Nothing may make the page scroll sideways.
- Nothing overlaps. The logo and nav keep clear space (switch to the burger menu before they would touch), and no text may sit under or be clipped by a form, photo, card or its own container. Decorative watermark text gets aria-hidden="true".

${scratch ? "WHY THEY NEED A SITE. The homepage must answer these:" : "ISSUES ON THE CURRENT SITE. The rebuild must fix every one:"}
${diagnosis.issues.map((i) => `- [${i.severity}] ${i.title}: ${i.detail}`).join("\n")}

BENCHMARKS: match or beat the quality of these ${benchmarks?.label ?? ""} homepages (${benchmarks?.register ?? ""}):
${(benchmarks?.sites ?? []).map((s) => `- ${s.name} (${s.url}): ${s.why}`).join("\n") || "- none available"}

FACTS: the only copy and claims you may use. Rewrite prose for clarity, but copy every figure, name and claim verbatim.
${buildFactsBlock(facts)}

${scratch ? "A screenshot of their Google Maps listing is attached for reference." : "Screenshots of the current site (desktop above the fold, and mobile) are attached for reference."}

Return one complete, self-contained HTML document (inline <style>, and inline <script> only if it's needed for the nav) in a single \`\`\`html block. Put nothing else in the reply.`;

  prompt += learned;
  prompt += agencyProfileBlock("design");

  if (moc) {
    prompt += `

DESIGN TO CLONE — the LAST attached image is a finished, professionally designed homepage. Rebuild THIS EXACT design for the business. The output must read as the SAME design re-skinned for this lead, not a page merely "inspired by" it. Match it closely:
- The whole page structure top to bottom: the header/nav treatment, the hero composition, and every section in the SAME order, with the same count and arrangement of blocks.
- The visual system: type hierarchy and scale, spacing rhythm, grid column counts, card/button/input/nav shapes and radii, image aspect ratios, and how sections are separated or overlap.
- Placeholder/grey tiles in the reference are photo slots — fill each with the lead's own photo (or a stock photo per IMAGE RULES) whose subject fits that slot, never with a grey box.

Change ONLY these, and nothing else that isn't required to make it work:
1. COLOURS — put THIS LEAD'S locked brand colours wherever the reference uses its accent/brand colour; derive tints and shades of the brand hue for secondary tones; keep the reference's neutrals (white, off-white, greys, near-black).
2. CONTENT — use only this lead's real logo, photos, words and FACTS. Never copy the reference's text, business name, numbers, prices, logos or images.
3. FONTS — choose Google Fonts that match the reference's typographic character (serif vs sans, weight, letter-spacing, case). The exact families need not match, but the FEEL must.
4. Drop a section only when the business has no real content for it (no team photos → no team section; no real numbers → no stats; no menu → no menu). Don't invent content and don't add sections the reference doesn't have.

The rules at the top still win: brand colours and logo locked, no invented facts, WCAG AA contrast, and it must work at 375px (collapse multi-column grids to one column, keep the mobile nav opening and closing).

After applying all of this, produce the full HTML document following every rule above, in a single \`\`\`html block with nothing else.`;
  } else if (recipe) {
    const withImg = recipe.sections.filter((x) => x.image && existsSync(x.image));
    prompt += `

DESIGN RECIPE — unique to this mockup (${recipe.niche})
This page is assembled from sections of DIFFERENT professional designs on purpose, then unified by one base style. The combination below was chosen so it doesn't repeat any mockup made before; don't fall back on a generic layout or on any other mockup.

BASE STYLE — "${recipe.style.name}"
${recipe.style.character}
${recipe.style.fonts ? `Fonts: ${recipe.style.fonts}\n` : ""}Start your <style> with this style's cssStarter, keeping its sizes, weights, spacing, radii and button shapes. Only change colour values: put THIS LEAD'S locked brand colour into the style's accent/brand slot (derive tints/shades where the style uses a second tone) and keep its neutrals. Load its Google Fonts.
${JSON.stringify(recipe.style.tokens, null, 1)}

SECTIONS, top to bottom. The LAST ${withImg.length} attached images are these sections' reference crops, in this order${withImg.length < recipe.sections.length ? " (sections without an image have none)" : ""}:
${recipe.sections.map((x, i) => `${i + 1}. ${x.role.toUpperCase()} — from ${x.from}${x.image ? "" : " (no image)"}: ${x.spec}`).join("\n")}

How to build it:
1. Copy each section's layout, composition, proportions and signature details from its reference crop and spec — but draw it with the BASE STYLE's fonts, colours, radii and buttons so the page feels like one site.
2. Keep this order. Drop a section only when the business has no real content for it (no reservations → turn a reservation block into a call/visit block; no team photos → no chef section; no real numbers → no stats). Don't add sections that aren't listed.
3. Grey "PHOTO" tiles in the crops are photo slots; fill them with the lead's photos or the stock photos (IMAGE RULES), never with grey boxes.
4. Use this lead's real logo, photos, words and facts. Never copy a reference's wording, names, numbers, prices, logos or images.
5. Only open the files named in this prompt. Don't look at or reuse other mockups.

After applying all of this, produce the full HTML document following every rule above, in a single \`\`\`html block with nothing else.`;
  } else if (ds && ds.measured) {
    prompt += `

DESIGN SYSTEM TO BUILD ON — "${ds.name}"
${ds.character}

The LAST ${refs.length} attached image${refs.length > 1 ? "s are" : " is"} this template's homepage at 1440px, top to bottom. Grey "PHOTO" tiles in them are photo slots (their size, shape and placement are part of the design). This is a real, professionally designed template and every number in the spec below was MEASURED from its rendered CSS. The mockup must read as this template re-skinned for this business — same proportions, spacing, type treatment and section craft — not as a generic page loosely inspired by it.

How to use it:
1. Start your <style> with the spec's "cssStarter" block, keeping every size, weight, line-height, letter-spacing, padding, radius, container width and section padding exactly as given. Only change the colour values: put THIS LEAD'S locked brand colour into the template's brand slot (the variable the spec names), derive tints/shades of it where the template uses a second tone of that hue, and keep the template's neutrals. Load the spec's Google Fonts.
2. Build the page in the order of "blueprint", using each section's layout and the matching "components" description. Drop a section only when the business has no real content for it (no team photos → no team section; no real numbers → no stats; no prices → no pricing) — never fill it with invented content. Don't add generic sections the template doesn't have.
3. Reproduce every item in "signatureMoves". These are what make it look designed rather than generic.
4. Match the reference images for alignment (centred vs left headings), the heading stack (eyebrow → heading → intro), card anatomy, photo sizes and aspect ratios, and how sections overlap each other.
5. Use this lead's real logo, photos, words and facts. Never copy the template's colours (other than neutrals), wording, names, numbers or images.
6. The rules at the top still win: brand colours and logo locked, no invented facts, contrast, mobile at 375px (collapse grids to one column, scale type with the spec's mobile values).

${JSON.stringify(ds.json, null, 1)}

After applying all of this, produce the full HTML document following every rule above, in a single \`\`\`html block with nothing else.`;
  } else if (ds) {
    prompt += `

DESIGN SYSTEM TO FOLLOW — "${ds.name}"
${ds.character}
The LAST attached image is a DESIGN REFERENCE from our professional template library. Match its visual quality, spacing and section craft — this is the bar. Adopt this system's type scale, spacing rhythm (especially its generous section padding), component styling (buttons, cards, inputs) and the section-layout ARCHETYPES in the spec below. Put THIS LEAD'S locked brand colour wherever the system uses its accent; use the lead's real logo and photos. Never copy the reference's colours, wording or images — only its structure, proportions and craft. You may use this system's fonts.

${JSON.stringify(ds.json, null, 1)}

After applying all of this, produce the full HTML document following every rule above, in a single \`\`\`html block with nothing else.`;
  }

  if (amend) {
    const prev = readFileSync(join(outDir, "index.html"), "utf8");
    if (opts?.changes) {
      prompt += `

REQUESTED CHANGES — the client reviewed the previous mockup and asked for exactly this. Apply it faithfully and change nothing else that isn't needed to make it work:
${opts.changes}`;
    }
    if (opts?.failures?.length) {
      prompt += `

YOUR PREVIOUS ATTEMPT FAILED THESE AUTOMATED CHECKS:
${opts.failures.map((f) => `- ${f.name}: ${f.detail}`).join("\n")}
Fix every failure.`;
    }
    prompt += `

Previous HTML:
\`\`\`html
${prev}
\`\`\`
Return the full corrected document.`;
  }

  const res = await runClaude({ leadId, task: "generate", cwd: dir, images, heavy: true, system: SYSTEM, prompt });
  const html = extractHtml(res.text);
  writeFileSync(join(outDir, "index.html"), html);
  return html;
}
