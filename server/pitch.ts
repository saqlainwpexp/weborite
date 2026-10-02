import { Router } from "express";
import { getBenchmarkSet } from "./pipeline/benchmarks.ts";
import { agencyProfileBlock, getLead, getSettings, leadDir, readJson } from "./db.ts";
import { extractFenced, extractJson, runClaude } from "./claude/runner.ts";
import type { Capture, Diagnosis, GateResult } from "../shared/types.ts";

/**
 * "How do I win this lead?" — drafts the closing email for a prospect.
 *
 * It reads the same facts the lead detail page shows (the form they submitted, the issues the
 * diagnosis found, the Lighthouse scores, the new mockup) and asks the chosen AI to write a warm,
 * specific sales email in the agency's house style: lead with the prospect's own words, tie every
 * promise to a real problem on their current site, explain the Google/SEO fixes, show the money,
 * state the price, and close softly. Numbers and claims are never invented — anything the data
 * doesn't support is left as a [bracketed placeholder] for the sender to fill in.
 */

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

export function leadFacts(id: string) {
  const lead = getLead(id);
  if (!lead) return null;
  const diagnosis = readJson<Diagnosis>(id, "diagnosis.json");
  const gate = readJson<GateResult>(id, "gate.json");
  const capture = readJson<Capture>(id, "capture.json");
  const benchmarks = lead.vertical ? getBenchmarkSet(lead.vertical) : null;
  const s = getSettings();
  const host = (() => { try { return new URL(lead.url).hostname.replace(/^www\./, ""); } catch { return lead.url; } })();

  const issues = (diagnosis?.issues ?? [])
    .slice()
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .map((i) => ({ severity: i.severity, area: i.category, problem: i.title, detail: i.detail }));

  return {
    business: lead.business || host,
    contactName: lead.name || "",
    email: lead.email || "",
    website: lead.url,
    host,
    hasWebsite: lead.mode !== "scratch",
    source:
      lead.source === "meta" ? "Meta Lead Ads form"
      : lead.source === "elementor" ? "a form on their own site"
      : lead.source === "maps" ? "the Lead Finder (found on Google Maps)"
      : "manual entry",
    // The exact fields they submitted — this is where ticked pain points like
    // "Not enough leads" or "It looks wrong on phones" live.
    formEntries: lead.fields,
    siteTitle: capture?.title ?? "",
    siteDescription: capture?.description ?? "",
    lighthouse: diagnosis?.lighthouse ?? null,
    issuesFound: issues,
    qualityChecksPassed: gate ? `${gate.checks.filter((c) => c.pass).length} of ${gate.checks.length}` : null,
    vertical: benchmarks ? { label: benchmarks.label, whatTheBuyerJudges: benchmarks.register } : null,
    currency: s.currency || "USD",
    senderEmail: s.agencyAdminEmail || "",
    // Set once the mockup is published live (Hostinger). When present, the email links it directly.
    liveMockupUrl: lead.publish?.url ?? "",
  };
}

const SYSTEM = `You write the closing email a small web-design agency sends a prospect after building them a free homepage mockup. One email, ready to send.

HOUSE STYLE (study this real example — match its warmth, structure and specificity, never copy its wording or facts):
---
Hi Jan,

Thanks again for asking us to look at sunbreezevilla.co.uk. We've given your website the full Florida treatment!

On the form you ticked "Not enough leads or enquiries", "Nobody finds us on Google" and "It looks wrong on phones", and asked us to check for anything else, so we built the new home page around all four.

Click Here for Mockup

This is a sketch of best practice built on your own navy and sea blue, your own photos and your own words.

What it fixes:
It loads properly on a phone. Your current home page is over 14 MB ... Google scores it 23 out of 100 on mobile. On the new page the same photos weigh about 2 MB ...
Your own words lead. "Where your Florida dreams become Florida memories" is now the first thing guests read ...
"Check dates & prices" is on every screen ...
Real guests, not sample text ...

Why nobody finds you on Google. Seven of your ten pages are all titled the same thing ... nothing tells Google this is a holiday rental near Orlando. We'll fix all of that as part of the build.

What it's worth. [ROI maths in their own numbers.]

Price. [one clear price, first year's hosting included, what's covered, what you need from them].

When you're ready, just reply "go ahead", ask us anything, or say "not now". Or reply with a good time and I'll give you a ring. Ten minutes, no slides.

Wish you were here! Speak soon.
---

RULES:
- Open warm and personal, addressed to the contact by first name (if you don't have one, use a friendly greeting like "Hi there").
- Second paragraph MUST reflect back the exact pain points / answers they gave in the form, quoted. Build the whole email around those.
- "What it fixes:" — a short bullet-ish list. Every item must map to a REAL problem from "issuesFound" or the Lighthouse scores, phrased as a benefit the owner feels. Use concrete numbers from the data (e.g. the mobile performance score) — never invent numbers.
- A "Why nobody finds you on Google" paragraph ONLY if there are structure/SEO issues or a low SEO/Lighthouse score; use the real findings.
- "What it's worth." — one short ROI paragraph. If you don't have real figures (prices, booking values, order values) from the form entries, write the money parts as [bracketed placeholders] for the sender to fill in — do NOT fabricate revenue.
- "Price." — if no price is given in the data, write it as [your price]. Mention first year's hosting and that you handle the technical move so nothing breaks.
- The mockup link: if "liveMockupUrl" is a real URL, put it on its own line as the call to view the new homepage. If it is empty, write the literal text [mockup link] on its own line for the sender to paste.
- Close softly: reply "go ahead", ask anything, "not now", or offer a quick call.
- British-to-neutral, plain, human. No hype, no em-dashes, no "unlock/elevate/seamless". Short sentences. Do not use markdown headers or bold; this is a plain email. 200-380 words.
- If the business has no current website (hasWebsite is false), reframe: they are invisible on Google and rely on a listing; the mockup is their first real site. Skip "your current site loads slowly" type lines.

Return ONLY a JSON object in a \`\`\`json fenced block: {"subject": "...", "body": "..."}. The body uses real newlines (\\n). No commentary outside the JSON.`;

export interface Pitch { subject: string; body: string; email: string }

/**
 * Pull {subject, body} out of a model reply. Prefers the JSON we asked for, but many providers
 * ignore that and just write the email as plain text — often a leading "Subject: ..." line (as seen
 * from "Subject:"/"Re:"/"Subj:") and then the body. Rather than crash on those, parse the plain form:
 * strip a fenced wrapper, lift a leading subject line if present, and treat the rest as the body.
 */
function parseEmail(text: string): { subject?: string; body?: string } {
  try {
    return extractJson<{ subject?: string; body?: string }>(text);
  } catch {
    // Fall through to plain-text parsing below.
  }
  let rest = extractFenced(text, "").trim(); // drop a ```...``` wrapper if the model added one
  let subject: string | undefined;
  const m = rest.match(/^\s*(?:subject|subj|re)\s*:\s*(.+?)(?:\r?\n|$)/i);
  if (m) {
    subject = m[1].trim();
    rest = rest.slice(m[0].length);
  }
  const body = rest.replace(/^(?:\r?\n)+/, "").trim();
  return { subject, body: body || undefined };
}

/** Draft the closing/outreach email for a lead. Throws "Lead not found" when the lead is gone. */
export async function makePitch(id: string): Promise<Pitch> {
  const facts = leadFacts(id);
  if (!facts) throw new Error("Lead not found");
  const r = await runClaude({
    leadId: id,
    task: "agent",
    system: SYSTEM,
    prompt:
      `Write the closing email for this lead. Here are the facts you may use (JSON). ` +
      `Use only what is here; mark anything missing as a [placeholder].\n\n` +
      JSON.stringify(facts, null, 1) +
      agencyProfileBlock("writing"),
    cwd: leadDir(id),
  });
  const out = parseEmail(r.text);
  const body = String(out.body ?? "").trim();
  if (!body) throw new Error("The AI did not return an email body");
  return { subject: String(out.subject ?? `A new homepage for ${facts.business}`).trim(), body, email: facts.email };
}

export const pitch = Router();

pitch.post("/:id", async (req, res) => {
  try {
    res.json(await makePitch(req.params.id));
  } catch (e) {
    const msg = (e as Error).message || "Couldn't draft the email";
    res.status(msg === "Lead not found" ? 404 : 502).json({ error: msg });
  }
});
