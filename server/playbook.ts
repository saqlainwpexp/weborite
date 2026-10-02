import { Router } from "express";
import { leadFacts } from "./pitch.ts";
import { leadDir } from "./db.ts";
import { runClaude } from "./claude/runner.ts";
import type { LeadPlaybook } from "../shared/types.ts";

/**
 * "How to win / close this lead" — the strategy notes, NOT the outreach email (that's pitch.ts).
 *
 * Reads the same facts the lead detail page shows and returns short, concrete coaching for the
 * owner: the angle to lead with, which of the prospect's own pain points to press, the objections to
 * expect and how to answer them, how to frame the price, and the single next step to push for.
 *
 * It returns the brief as plain text (not JSON) on purpose — this is read-only display, and every AI
 * provider the app supports can produce clean prose reliably, whereas weaker models often ignore a
 * "return JSON" instruction.
 */

const SYSTEM = `You are a sales coach for a small web-design agency. The agency just built a free homepage mockup for a prospect and wants to know how to WIN and CLOSE this specific lead. You are NOT writing an email to the prospect — you are briefing the agency owner.

Use ONLY the facts given. Never invent numbers, prices, review counts or revenue; where a figure would help but isn't in the data, write it as a [bracketed placeholder] for the owner to fill in.

Write a short brief with EXACTLY these five labelled sections, each as a heading line ending with a colon followed by a few short sentences or 2-4 terse "- " bullet lines:

Angle:
(the single strongest angle to lead with for THIS business, tied to their real situation)

Their pain points:
(the prospect's own stated or evident pain points to press on — quote the form answers / real issues)

Likely objections:
(the 2-3 objections most likely here and a crisp answer to each)

Pricing:
(how to frame and anchor the price for this lead — real figures if present, else [placeholders])

Next step:
(the one concrete next step to push for, and how to ask for it)

Plain text only. No markdown bold or headers, no hype, no em-dashes. Output only the brief.`;

export const playbook = Router();

export async function makePlaybook(id: string): Promise<LeadPlaybook> {
  const facts = leadFacts(id);
  if (!facts) throw new Error("Lead not found");
  const r = await runClaude({
    leadId: id,
    task: "agent",
    system: SYSTEM,
    prompt: `Brief the owner on how to win and close this lead. Facts (JSON):\n\n${JSON.stringify(facts, null, 1)}`,
    cwd: leadDir(id),
  });
  const text = r.text.trim();
  if (!text) throw new Error("The AI returned an empty playbook");
  return { text };
}

playbook.post("/:id", async (req, res) => {
  try {
    res.json(await makePlaybook(req.params.id));
  } catch (e) {
    const msg = (e as Error).message || "Couldn't build the playbook";
    res.status(msg === "Lead not found" ? 404 : 502).json({ error: msg });
  }
});
