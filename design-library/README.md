# Design library

This folder is the design system that steers mockup generation so the output looks *designed*, not
AI-generic. Each lead is matched to the closest system here, and that system (plus its reference
images) is fed into the generator while the lead keeps its own brand colour, logo and real photos.

There are **two kinds** of entry. A lead uses the first that matches; if neither matches a niche,
the generator rotates across the measured systems for variety (see `server/pipeline/generate.ts`).

> The app prefers a copy of this folder in the data directory (`<STUDIO_DATA>/design-library`) over
> the one shipped in the repo, so you can add or edit systems on an installed build without rebuilding.

---

## 1. Clustered niche libraries (`<niche>/library.json`)  ← preferred

A niche (restaurants, clinics, trades, legal, real-estate, coaching, fitness, aesthetics,
interior-design, flooring…) holds **base styles** and **many section variants** taken from several
different real designs. The recipe engine (`server/pipeline/recipe.ts`) mixes one style + a page
order + one variant per section, chosen to be as far as possible from every recipe already used — so
no two leads, and no two regenerations of one lead, share a layout.

```
<niche>/
  library.json        # the spec (below)
  1.webp … N.webp     # the source design screenshots the crops come from
  sections/<id>.jpg   # one cropped reference image per section variant (generated, see below)
  _sources.json       # where each source screenshot came from (attribution, optional)
```

`library.json` shape:

```jsonc
{
  "niche": "restaurants",
  "match": "restaurant|eatery|bistro|pizzeria|cafe|bakery|...",   // regex tested against the lead's vertical text
  "styles": [
    { "id": "noir", "name": "Noir fine dining", "fits": "fine dining steak sushi upscale",
      "character": "Near-black canvas, one warm accent, ...", "fonts": "Playfair Display + Inter",
      "cssStarter": ":root{ ... }" }
    // a style may instead point at a measured system: { "id":"...", "system":"airvice" }
  ],
  "orders": [ ["hero","about","menu","gallery","testimonials","reservation","visit","footer"], ... ],
  "sections": [
    { "id": "hero-savorelle", "role": "hero", "from": "1 Savorelle",
      "crop": { "src": "1.webp", "x": 0, "y": 0, "w": 1440, "h": 1024 },
      "spec": "Minimal header (wordmark left, centred nav), full-bleed dish photo, ..." }
    // one entry per variant; `role` must appear in at least one `orders` array
  ]
}
```

Add a niche:
1. Collect 6–12 full-page design screenshots into `<niche>/` as `1.webp … N.webp`.
2. Write `library.json`: a `match` regex, 2–4 `styles`, a few `orders`, and `sections` with a
   `crop` rect per variant (at least 3 different `from` sources so a recipe is a real mix).
3. Generate the per-section crops: `python scripts/crop-sections.py <niche>` (reads the `crop`
   rects and writes `sections/<id>.jpg`).

## 2. Measured single-template systems (`<slug>/design-system.json`)

A whole template measured from real rendered CSS (exact type scale, spacing, components, blueprint,
signature moves) with its page captured top-to-bottom as `reference-1.jpg … reference-N.jpg`. Used
as a fallback when no niche library matches, rotated across leads so unmatched verticals don't all
come out the same.

```
<slug>/
  design-system.json   # { name, tier:"measured", character, cssStarter, typography, color,
                        #   spacing, components, blueprint, signatureMoves, ... }
  reference-1.jpg …     # the template's homepage, sliced top to bottom
  measured.json         # raw measurements (optional)
```

Add one: `node scripts/extract-template.mjs <url-or-local-html>` captures and measures a template,
then fill in `character`/`reuse` and the `fits` keywords.

---

## Adding the new Dribbble-based sets

New clustered sets go in as **format 1** above (`library.json` + `crop` rects + `crop-sections.py`).
Group the Dribbble shots by niche, keep the brand colours OUT of the `cssStarter` (the lead's brand
colour is injected at generation time — only neutrals and structure come from here), and make sure
each new niche's `match` regex doesn't overlap an existing one more than intended.
