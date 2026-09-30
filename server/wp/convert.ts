import { extractFenced, runClaude } from "../claude/runner.ts";
import { ELEMENTOR_REFERENCE, FREE_WIDGETS, PRO_WIDGETS } from "./reference.ts";
import { checkWidgetPhp, validateElements, type ElementorElement } from "./validate.ts";
import type { SectionDigest } from "./digest.ts";

export interface CustomWidgetDraft {
  name: string;
  title: string;
  replaces: string;
  php: string;
}

export interface ConvertedSection {
  elements: ElementorElement[];
  widgets: string[];
  customWidgets: CustomWidgetDraft[];
  attempts: number;
}

const SYSTEM = `You are a senior Elementor developer. You convert hand-coded HTML sections into Elementor page data that renders pixel-identical, using ONLY native Elementor containers and widgets.

Hard rules:
- Never use the HTML, Shortcode or any WordPress text/HTML widget. No raw HTML in Text Editor beyond simple inline formatting (p, br, strong, em, a, ul, ol, li, span) and no inline styles anywhere: every visual property goes into Elementor controls.
- Reproduce every measured value: container padding, gaps, max widths, backgrounds, borders, radii, shadows, font family, size, weight, line height, letter spacing, text transform and colours. Use px exactly as measured.
- Match the mobile layout with _mobile responsive controls (flex_direction_mobile, padding_mobile, typography_font_size_mobile, etc.). Tablet can inherit desktop unless the section clearly needs it.
- Keep the text content exactly as in the HTML. Keep links (href) exactly.
- Use flexbox containers for layout, and grid containers for regular grids. Nest containers the way the HTML is nested only where it's needed for layout; don't add pointless wrappers.
- Output valid JSON only, no comments and no trailing commas.`;

function mediaNote(media: Record<string, { url: string; id: number | "" }>) {
  const entries = Object.entries(media);
  if (!entries.length) return "No uploaded media. Use the src values exactly as given.";
  return "Image and video sources are uploaded to WordPress. Replace each local path with its WordPress url and id:\n" + entries.map(([k, v]) => `- ${k} → {"url":"${v.url}","id":${v.id === "" ? '""' : v.id}}`).join("\n");
}

function parseReply(text: string) {
  const json = extractFenced(text, "json");
  const start = json.indexOf("[");
  const end = json.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("No JSON array in the reply");
  const elements = JSON.parse(json.slice(start, end + 1));
  const customWidgets: CustomWidgetDraft[] = [];
  for (const m of text.matchAll(/```php\s*\n([\s\S]*?)```/g)) {
    const php = m[1].trim();
    const head = php.match(/studio-widget:\s*([a-z0-9_]+)\s*\|\s*([^|\n]+)\|\s*([^\n*]+)/i);
    if (head) customWidgets.push({ name: head[1].trim(), title: head[2].trim(), replaces: head[3].trim(), php: php.startsWith("<?php") ? php : `<?php\n${php}` });
  }
  return { elements, customWidgets };
}

/** Convert one measured section into Elementor elements, retrying once with validator feedback. */
export async function convertSection(input: {
  leadId: string;
  cwd: string;
  section: SectionDigest;
  fonts: string[];
  pro: boolean;
  media: Record<string, { url: string; id: number | "" }>;
  existingCustomWidgets: { name: string; replaces: string; controls?: string }[];
  feedback?: string;
}): Promise<ConvertedSection> {
  const { section, pro } = input;
  const widgetPolicy = pro
    ? `Elementor Pro IS in scope. Allowed widgets: ${[...FREE_WIDGETS, ...PRO_WIDGETS].join(", ")}. Use Pro widgets where they're the natural fit (nav-menu for navigation, form for forms, and so on).`
    : `Elementor Pro is NOT in scope. Allowed widgets: ${FREE_WIDGETS.join(", ")}${input.existingCustomWidgets.length ? `, plus these existing custom widgets: ${input.existingCustomWidgets.map((w) => `${w.name} (replaces ${w.replaces})`).join(", ")}` : ""}.
If the section genuinely needs something only a Pro widget does (for example a working contact form, a responsive nav menu with a mobile toggle, a slider, a price table or a testimonial carousel), create a CUSTOM WIDGET instead:
  - Use it in the JSON as {"elType":"widget","widgetType":"studio_<purpose>","settings":{…}}.
  - Supply its full PHP in a separate \`\`\`php block whose first line is: // studio-widget: studio_<purpose> | <Title> | <Pro widget it replaces>
  - The class is named Studio_Widget_<Purpose> (for example Studio_Widget_Contact_Form), extends \\Elementor\\Widget_Base, get_categories() returns ['studio'], get_name() returns 'studio_<purpose>', registers real Elementor controls (content + style tabs with selectors) for everything that's editable, and renders with esc_html/esc_url/esc_attr. It may enqueue no external assets; put its CSS in a <style> printed once in render() guarded by a static flag, and any JS inline, vanilla, with no dependencies.
  - Forms never send mail themselves. They POST to <?php echo esc_url( admin_url( 'admin-post.php' ) ); ?> with these hidden fields, printed by calling studio_form_fields( '<form name>' ) inside the <form>: action=studio_form, the form name, a nonce, a honeypot and a timestamp. Name the visible inputs name, email, phone and message where they fit (other names are passed through). The connector's handler checks the honeypot, the time taken and a per-visitor rate limit, emails the site's form recipient through the site's mail setup (FluentSMTP), and redirects back; render() shows a thank-you or error message when studio_form_status( '<form name>' ) returns 'sent' or 'error' (it returns '' otherwise). No superglobals in render().
  - Prefer free widgets whenever they can do the job. Only reach for a custom widget when they can't.`;

  let prompt = `Convert this section into Elementor data.

${widgetPolicy}

${ELEMENTOR_REFERENCE}

FONTS the site loads from Google Fonts: ${input.fonts.join(", ") || "system fonts"} (use these family names in typography controls).

${mediaNote(input.media)}

SECTION: ${section.label} (<${section.tag}>, ${section.height}px tall at 1440px)

MEASURED AT 1440px (tag.class WIDTHxHEIGHT then computed styles; indentation = nesting):
${section.desktop}

CHANGES AT 375px (only lines that differ):
${section.mobile || "(nothing changes except widths)"}

HTML (for text, links and structure):
${section.html}

Screenshots of the section at 1440px and 375px are attached.
${input.feedback ? `\nREVIEWER FEEDBACK to address in this version:\n${input.feedback}\n` : ""}
Reply with the section as a JSON array of top-level container(s) in a single \`\`\`json block${pro ? "" : ", followed by any custom widget ```php blocks"}. Nothing else.`;

  const customNames = input.existingCustomWidgets.map((w) => w.name);
  let lastErrors: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await runClaude({
      leadId: input.leadId, task: "build", cwd: input.cwd, heavy: true, system: SYSTEM,
      images: [section.shotDesktop, section.shotMobile],
      prompt,
    });
    let parsed: ReturnType<typeof parseReply>;
    try {
      parsed = parseReply(res.text);
    } catch (e) {
      lastErrors = [`Reply could not be parsed: ${(e as Error).message}`];
      prompt += `\n\nYOUR PREVIOUS REPLY FAILED: ${lastErrors[0]}. Reply again with one \`\`\`json block containing the array.`;
      continue;
    }
    const newWidgets = pro ? [] : parsed.customWidgets;
    const phpErrors = newWidgets.flatMap((w) => checkWidgetPhp(w.name, w.php));
    const v = validateElements(parsed.elements, { pro, customWidgets: [...customNames, ...newWidgets.map((w) => w.name)] });
    lastErrors = [...v.errors, ...phpErrors];
    if (!lastErrors.length) return { elements: v.elements, widgets: v.widgets, customWidgets: newWidgets, attempts: attempt };
    prompt += `\n\nYOUR PREVIOUS REPLY FAILED VALIDATION. Fix every point and reply again in the same format:\n${lastErrors.map((e) => `- ${e}`).join("\n")}`;
  }
  throw new Error(`Section "${section.label}" failed validation: ${lastErrors.slice(0, 4).join("; ")}`);
}
