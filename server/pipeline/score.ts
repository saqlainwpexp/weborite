import { leadTemp, type Diagnosis, type Lead, type LeadTemp } from "../../shared/types.ts";

/**
 * Lead score 0–100: how worth chasing a lead is, from how reachable they are, how much upside the
 * new site offers, and (for Lead Finder leads) the prospect's fit score. Computed once the diagnosis
 * is in and stored on the lead, so the Leads table can sort and filter by hot / warm / cold.
 */
export function scoreLead(lead: Lead, diagnosis: Diagnosis | null, fitScore?: number): { score: number; temp: LeadTemp } {
  // Base: the Lead Finder's own fit score when we have one, otherwise a neutral middle.
  let s = typeof fitScore === "number" ? fitScore : 50;

  // Reachability — a lead you can contact is worth more.
  if (lead.email) s += 14;
  if (lead.phone) s += 6;

  // Intent — they filled a form themselves (not a cold list we found on Maps).
  if (lead.source === "meta" || lead.source === "elementor") s += 10;

  // Upside — the more wrong with the current site, the stronger the pitch.
  const issues = diagnosis?.issues ?? [];
  const high = issues.filter((i) => i.severity === "high").length;
  s += Math.min(18, issues.length * 3 + high * 3);
  if (lead.mode === "scratch") s += 8; // no website at all: everything to gain

  // A poor mobile score is the easiest win to sell.
  const perf = diagnosis?.lighthouse?.performance;
  if (typeof perf === "number" && perf < 50) s += 6;

  const score = Math.max(0, Math.min(100, Math.round(s)));
  return { score, temp: leadTemp(score) };
}
