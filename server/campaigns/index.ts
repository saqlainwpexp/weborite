import { Router } from "express";
import { addEvent, getLead } from "../db.ts";
import { intakeLead } from "../intake.ts";
import { createSearch, getSearch, getProspect, listProspects, saveProspect } from "../finder/store.ts";
import { enqueueSearch } from "../finder/queue.ts";
import { createCampaign, deleteCampaign, getCampaign, listCampaigns, saveCampaign, updateCampaign } from "./store.ts";
import { demoCap, demoLeft, demoLimitMessage, isDemo } from "../license/index.ts";
import { DEMO_RESULTS } from "../../shared/demo.ts";
import type { Campaign, CampaignItem, Prospect } from "../../shared/types.ts";

/**
 * Campaigns: hands-off outreach pipelines. You give a prompt ("20 HVAC companies in Austin"); it
 * scrapes the businesses (Lead Finder), then auto-generates a mockup for each using the design
 * library. When the mockups are ready it waits for you to arm the email send (SMTP — next phase).
 */

/** Turn a mockup lead's status into the campaign item's coarse status. */
function mockupStatus(leadStatus: string | undefined): CampaignItem["mockupStatus"] {
  if (leadStatus === "ready") return "ready";
  if (leadStatus === "needs_review") return "review";
  if (leadStatus === "failed") return "failed";
  return "generating";
}

/** Create a mockup lead from a scraped prospect (mirrors the Lead Finder "Create mockup" action). */
export function mockupFromProspect(p: Prospect): CampaignItem {
  const scratch = !p.website || Boolean(p.fit?.audit?.socialOnly);
  const fields: Record<string, string> = scratch
    ? { Business: p.name, "Google Maps": p.mapsUrl, Website: p.website || "None" }
    : { Website: p.website, Business: p.name };
  if (p.phone) fields.Phone = p.phone;
  if (p.emails[0]) fields.Email = p.emails[0];
  if (p.category) fields.Category = p.category;
  if (p.reviews != null) fields["Google reviews"] = `${p.rating ?? "–"} ★ (${p.reviews})`;
  const { lead } = intakeLead({ source: "maps", url: scratch ? p.mapsUrl : p.website, name: "", email: p.emails[0] ?? "", phone: p.phone, business: p.name, fields, mode: scratch ? "scratch" : "rebuild", prospectId: p.id });
  p.mockupLeadId = lead.id;
  saveProspect(p);
  return { prospectId: p.id, business: p.name, url: p.website || p.mapsUrl, scratch, email: p.emails[0] ?? "", phone: p.phone, mockupLeadId: lead.id, mockupStatus: "generating", emailStatus: "none" };
}

/* ---------- the pump: advances every campaign a step ---------- */

function advance(c: Campaign) {
  if (c.status === "scraping") {
    const search = getSearch(c.searchId);
    if (!search) { c.status = "failed"; c.note = "The search was removed."; return; }
    const found = listProspects({ searchId: c.searchId });
    if (search.status === "done" || search.status === "failed") {
      if (!found.length) { c.status = "failed"; c.note = "No businesses found for that prompt."; return; }
      // The demo only has a few mockups: take as many as it has left.
      const room = Math.min(c.max, demoLeft("mockups"));
      if (room <= 0) { c.status = "failed"; c.note = demoLimitMessage("mockups"); return; }
      c.items = found.slice(0, room).map(mockupFromProspect);
      c.status = "generating";
      c.note = isDemo() && found.length > c.items.length
        ? `Generating ${c.items.length} of ${found.length} mockups: the demo had ${c.items.length} left. A license makes all of them.`
        : `Generating ${c.items.length} mockups…`;
      addEvent({ leadId: null, kind: "info", title: "Campaign started generating", detail: `${c.prompt}: ${c.items.length} mockups queued` });
    } else {
      c.note = `Finding businesses… ${found.length} so far`;
    }
    return;
  }
  if (c.status === "generating") {
    let done = 0;
    for (const it of c.items) {
      it.mockupStatus = mockupStatus(getLead(it.mockupLeadId ?? "")?.status);
      if (it.mockupStatus === "ready" || it.mockupStatus === "review" || it.mockupStatus === "failed") done++;
    }
    const ready = c.items.filter((i) => i.mockupStatus === "ready" || i.mockupStatus === "review").length;
    c.note = `Mockups: ${done}/${c.items.length} done`;
    if (done === c.items.length) {
      c.status = "ready";
      c.note = `${ready} mockups ready to review. Arm the batch to send.`;
      addEvent({ leadId: null, kind: "info", title: "Campaign ready", detail: `${c.prompt}: ${ready} mockups ready to send` });
    }
    return;
  }
  // "ready" / "armed" / "sending" / "done": email phase (SMTP) — added next.
}

let timer: NodeJS.Timeout | null = null;
export function startCampaignTimers() {
  if (timer) return;
  const tick = () => {
    for (const c of listCampaigns()) {
      if (["done", "failed"].includes(c.status)) continue;
      if (c.status === "armed" || c.status === "sending") continue; // email phase, no auto-advance yet
      try {
        updateCampaign(c.id, advance);
      } catch (e) {
        console.error(`[campaign ${c.id}]`, e);
      }
    }
  };
  timer = setInterval(tick, 8000);
  setTimeout(tick, 3000);
}

/* ---------- routes ---------- */

export const campaigns = Router();

campaigns.get("/", (_req, res) => res.json(listCampaigns()));

campaigns.post("/", (req, res) => {
  const prompt = String(req.body?.prompt ?? "").trim();
  if (prompt.length < 4) return res.status(400).json({ error: "Describe who to reach, e.g. “20 HVAC companies in Austin”" });
  const m = prompt.match(/\b(\d{1,3})\b/);
  const max = demoCap(m ? Math.min(120, Math.max(1, Number(m[1]))) : 20, DEMO_RESULTS);
  const query = prompt.replace(/\b\d{1,3}\b\s*/, "").replace(/^(find|get|scrape)\s+/i, "").trim() || prompt;
  const search = createSearch(query, max);
  enqueueSearch(search.id);
  const c = createCampaign({ prompt, query, max, searchId: search.id });
  addEvent({ leadId: null, kind: "info", title: "Campaign created", detail: `${prompt} (up to ${max})` });
  res.json(c);
});

campaigns.get("/:id", (req, res) => {
  const c = getCampaign(req.params.id);
  if (!c) return res.sendStatus(404);
  res.json(c);
});

campaigns.delete("/:id", (req, res) => {
  deleteCampaign(req.params.id);
  res.json({ ok: true });
});

/** Arm the batch to send (email send is the next phase; this records intent for now). */
campaigns.post("/:id/arm", (req, res) => {
  const c = updateCampaign(req.params.id, (x) => {
    if (x.status !== "ready") return;
    x.status = "armed";
    x.note = "Armed. Email sending needs your SMTP details in Settings (coming next).";
  });
  if (!c) return res.sendStatus(404);
  res.json(c);
});
