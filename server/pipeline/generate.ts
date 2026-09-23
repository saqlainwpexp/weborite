import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { leadDir } from "../db.ts";
import { extractHtml, runClaude } from "../claude/runner.ts";
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
  retry?: { failures: GateCheck[] },
) {
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
  const otherAssets = capture.assets
    .filter((a) => a.path !== sa?.path)
    .map((a) => ({ src: rel(a.path), kind: a.kind, size: a.width && a.height ? `${a.width}x${a.height}` : undefined }));

  const images = [join(dir, "desktop-fold.jpg"), join(dir, "mobile.jpg")].filter(existsSync);

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

${scratch ? "WHY THEY NEED A SITE. The homepage must answer these:" : "ISSUES ON THE CURRENT SITE. The rebuild must fix every one:"}
${diagnosis.issues.map((i) => `- [${i.severity}] ${i.title}: ${i.detail}`).join("\n")}

BENCHMARKS: match or beat the quality of these ${benchmarks?.label ?? ""} homepages (${benchmarks?.register ?? ""}):
${(benchmarks?.sites ?? []).map((s) => `- ${s.name} (${s.url}): ${s.why}`).join("\n") || "- none available"}

FACTS: the only copy and claims you may use. Rewrite prose for clarity, but copy every figure, name and claim verbatim.
${buildFactsBlock(facts)}

${scratch ? "A screenshot of their Google Maps listing is attached for reference." : "Screenshots of the current site (desktop above the fold, and mobile) are attached for reference."}

Return one complete, self-contained HTML document (inline <style>, and inline <script> only if it's needed for the nav) in a single \`\`\`html block. Put nothing else in the reply.`;

  if (retry) {
    const prev = readFileSync(join(outDir, "index.html"), "utf8");
    prompt += `

YOUR PREVIOUS ATTEMPT FAILED THESE AUTOMATED CHECKS:
${retry.failures.map((f) => `- ${f.name}: ${f.detail}`).join("\n")}

Previous HTML:
\`\`\`html
${prev}
\`\`\`
Fix every failure and return the full corrected document.`;
  }

  const res = await runClaude({ leadId, task: "generate", cwd: dir, images, heavy: true, system: SYSTEM, prompt });
  const html = extractHtml(res.text);
  writeFileSync(join(outDir, "index.html"), html);
  return html;
}
