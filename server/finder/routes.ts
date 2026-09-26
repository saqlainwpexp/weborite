import { Router } from "express";
import { getLead } from "../db.ts";
import { intakeLead } from "../intake.ts";
import { cancelSearch, enqueueSearch, enrichProspect } from "./queue.ts";
import {
  createSearch, deleteProspect, deleteSearch, finderStats, getProspect, getSearch, listProspects, listSearches, refreshSearchCounts, saveProspect,
} from "./store.ts";
import type { Prospect } from "../../shared/types.ts";
import { existsSync } from "node:fs";
import { queueQualify, shotPath } from "./qualify.ts";

export const finder = Router();

finder.get("/stats", (_req, res) => res.json(finderStats()));

finder.get("/searches", (_req, res) => res.json(listSearches()));

finder.post("/searches", (req, res) => {
  const query = String(req.body?.query ?? "").trim();
  const max = Math.min(Math.max(Number(req.body?.max) || 20, 1), 120);
  if (query.length < 3) return res.status(400).json({ error: "Describe what to search for, e.g. “HVAC companies in Rotterdam”" });
  const s = createSearch(query, max);
  enqueueSearch(s.id);
  res.json(s);
});

finder.get("/searches/:id", (req, res) => {
  const s = getSearch(req.params.id);
  if (!s) return res.sendStatus(404);
  res.json({ ...s, prospects: listProspects({ searchId: s.id }) });
});

finder.post("/searches/:id/stop", (req, res) => {
  cancelSearch(req.params.id);
  res.json({ ok: true });
});

finder.post("/searches/:id/rerun", (req, res) => {
  const s = getSearch(req.params.id);
  if (!s) return res.sendStatus(404);
  enqueueSearch(s.id);
  res.json({ ok: true });
});

finder.delete("/searches/:id", (req, res) => {
  cancelSearch(req.params.id);
  deleteSearch(req.params.id);
  res.json({ ok: true });
});

finder.get("/prospects", (req, res) => {
  const searchId = typeof req.query.search === "string" ? req.query.search : undefined;
  res.json(listProspects({ searchId }));
});

finder.get("/prospects/:id", (req, res) => {
  const p = getProspect(req.params.id);
  if (!p) return res.sendStatus(404);
  res.json({ ...p, search: getSearch(p.searchId), mockup: p.mockupLeadId ? getLead(p.mockupLeadId) : null });
});

finder.post("/prospects/:id/enrich", async (req, res) => {
  const p = getProspect(req.params.id);
  if (!p) return res.sendStatus(404);
  await enrichProspect(p.id);
  refreshSearchCounts(p.searchId);
  res.json(getProspect(p.id));
});

/** Re-score one business (audit its website again). */
finder.post("/prospects/:id/qualify", (req, res) => {
  const p = getProspect(req.params.id);
  if (!p) return res.sendStatus(404);
  void queueQualify([p.id]);
  res.json({ ok: true });
});

/** Score every business that hasn't been scored yet (or all, with ?all=1). */
finder.post("/qualify", (req, res) => {
  const all = req.query.all === "1";
  const only: string[] | null = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
  const ids = listProspects().filter((p) => (only ? only.includes(p.id) : all || !p.fit || p.fit.status === "failed")).map((p) => p.id);
  void queueQualify(ids);
  res.json({ queued: ids.length });
});

finder.get("/prospects/:id/shot", (req, res) => {
  if (!/^[\w-]+$/.test(req.params.id)) return res.sendStatus(400);
  const f = shotPath(req.params.id);
  if (!existsSync(f)) return res.sendStatus(404);
  res.sendFile(f);
});

finder.delete("/prospects/:id", (req, res) => {
  const p = getProspect(req.params.id);
  if (!p) return res.sendStatus(404);
  deleteProspect(p.id);
  refreshSearchCounts(p.searchId);
  res.json({ ok: true });
});

/** Delete several leads at once (the Leads table's bulk action). */
finder.post("/prospects/delete", (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  const searches = new Set<string>();
  let deleted = 0;
  for (const id of ids) {
    const p = getProspect(id);
    if (!p) continue;
    deleteProspect(p.id);
    searches.add(p.searchId);
    deleted++;
  }
  for (const s of searches) refreshSearchCounts(s);
  res.json({ deleted });
});

/** Hand a found business to the Mockups workspace. */
finder.post("/prospects/:id/mockup", (req, res) => {
  const p = getProspect(req.params.id);
  if (!p) return res.sendStatus(404);
  // No website: design one from scratch from the Google Maps listing.
  const scratch = !p.website || p.fit?.audit?.socialOnly || req.body?.scratch === true;
  const fields: Record<string, string> = scratch ? { Business: p.name, "Google Maps": p.mapsUrl, Website: p.website || "None" } : { Website: p.website, Business: p.name };
  if (p.phone) fields.Phone = p.phone;
  if (p.emails[0]) fields.Email = p.emails[0];
  if (p.category) fields.Category = p.category;
  if (p.reviews != null) fields["Google reviews"] = `${p.rating ?? "–"} ★ (${p.reviews})`;
  fields["Found via"] = `Google Maps · ${getSearch(p.searchId)?.query ?? ""}`;
  const { lead } = intakeLead({ source: "maps", url: scratch ? p.mapsUrl : p.website, name: "", email: p.emails[0] ?? "", phone: p.phone, business: p.name, fields, mode: scratch ? "scratch" : "rebuild", prospectId: p.id });
  p.mockupLeadId = lead.id;
  saveProspect(p);
  res.json({ leadId: lead.id });
});

const csvCell = (v: unknown) => {
  let s = v == null ? "" : String(v);
  // Keep spreadsheets from running cell text as a formula; plain phone numbers (+31…) are safe.
  if (/^[=+\-@]/.test(s) && !/^\+?[\d\s().-]+$/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

finder.get("/export.csv", (req, res) => {
  const searchId = typeof req.query.search === "string" ? req.query.search : undefined;
  const tag = typeof req.query.tag === "string" ? req.query.tag : "";
  const ids = typeof req.query.ids === "string" && req.query.ids ? new Set(req.query.ids.split(",")) : null;
  const rows = listProspects({ searchId }).filter((p: Prospect) => (!tag || p.tags.includes(tag)) && (!ids || ids.has(p.id)));
  const head = ["Business", "Fit score", "Fit", "Why", "Category", "Phone", "WhatsApp", "Emails", "Website", "Rating", "Reviews", "Address", "Google Maps", "Search"];
  const searches = new Map(listSearches().map((s) => [s.id, s.query]));
  const lines = rows.map((p) =>
    [p.name, p.fit?.status === "done" ? p.fit.score : "", p.fit?.status === "done" ? p.fit.grade : "", p.fit?.status === "done" ? p.fit.reasons.filter((r) => r.points >= 0).slice(0, 3).map((r) => r.text).join("; ") : "", p.category, p.phone, p.tags.includes("whatsapp") ? "yes" : "", p.emails.join(" "), p.website, p.rating, p.reviews, p.address, p.mapsUrl, searches.get(p.searchId)]
      .map(csvCell).join(","),
  );
  res.attachment(`leads-${new Date().toISOString().slice(0, 10)}.csv`);
  res.type("text/csv").send([head.join(","), ...lines].join("\n"));
});
