import { Router } from "express";
import { getLead } from "../db.ts";
import { intakeLead, leadFromFields } from "../intake.ts";
import { DemoLimitError } from "../license/index.ts";
import {
  createMetaLead, deleteMetaLead, getMetaLead, importMetaCsv, listMetaLeads, metaLeadStats, saveMetaLead,
} from "./metaStore.ts";
import { META_LEAD_STATUS, type MetaLead, type MetaLeadStatus } from "../../shared/types.ts";

export const meta = Router();

const STATUSES = new Set(META_LEAD_STATUS.map((s) => s.key));

meta.get("/stats", (_req, res) => res.json(metaLeadStats()));

meta.get("/leads", (_req, res) => res.json(listMetaLeads()));

meta.get("/leads/:id", (req, res) => {
  const l = getMetaLead(req.params.id);
  if (!l) return res.sendStatus(404);
  res.json({ ...l, mockup: l.mockupLeadId ? getLead(l.mockupLeadId) : null });
});

/** Add a lead by hand. */
meta.post("/leads", (req, res) => {
  const b = req.body ?? {};
  const name = String(b.name ?? "").trim();
  const email = String(b.email ?? "").trim();
  const phone = String(b.phone ?? "").trim();
  if (!name && !email && !phone) return res.status(400).json({ error: "Give at least a name, email or phone." });
  const { lead, duplicate } = createMetaLead({
    source: "manual", name, email, phone,
    company: String(b.company ?? "").trim(),
    campaign: String(b.campaign ?? "").trim(),
    platform: String(b.platform ?? "").trim(),
    notes: String(b.notes ?? "").trim(),
    fields: b.fields && typeof b.fields === "object" ? b.fields : {},
  });
  res.json({ ...lead, duplicate });
});

/** Import a CSV export (Meta Lead Center, or any ad platform). Body: { csv: string }. */
meta.post("/leads/import", (req, res) => {
  const csv = typeof req.body?.csv === "string" ? req.body.csv : "";
  if (!csv.trim()) return res.status(400).json({ error: "Paste or upload a CSV file first." });
  res.json(importMetaCsv(csv));
});

/** Update status, labels, notes or any editable field. */
meta.patch("/leads/:id", (req, res) => {
  const l = getMetaLead(req.params.id);
  if (!l) return res.sendStatus(404);
  const b = req.body ?? {};
  if (b.status !== undefined) {
    if (!STATUSES.has(b.status)) return res.status(400).json({ error: "Unknown status" });
    l.status = b.status as MetaLeadStatus;
  }
  if (Array.isArray(b.labels)) l.labels = b.labels.map(String);
  if (b.notes !== undefined) l.notes = String(b.notes);
  for (const k of ["name", "email", "phone", "company", "campaign", "platform"] as const) {
    if (b[k] !== undefined) l[k] = String(b[k]);
  }
  saveMetaLead(l);
  res.json(l);
});

meta.delete("/leads/:id", (req, res) => {
  if (!getMetaLead(req.params.id)) return res.sendStatus(404);
  deleteMetaLead(req.params.id);
  res.json({ ok: true });
});

/** Delete several leads at once (the table's bulk action). */
meta.post("/leads/delete", (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  let deleted = 0;
  for (const id of ids) if (getMetaLead(id)) { deleteMetaLead(id); deleted++; }
  res.json({ deleted });
});

/** Hand a lead to the Mockups workspace — needs a website answer in the form. */
meta.post("/leads/:id/mockup", (req, res) => {
  const l = getMetaLead(req.params.id);
  if (!l) return res.sendStatus(404);
  if (l.mockupLeadId) return res.json({ leadId: l.mockupLeadId, duplicate: true });
  // Merge the known contact details with the raw form answers, then look for a website.
  const fields: Record<string, string> = { ...l.fields };
  if (l.name) fields.Name = l.name;
  if (l.email) fields.Email = l.email;
  if (l.phone) fields.Phone = l.phone;
  if (l.company) fields.Business = l.company;
  const input = leadFromFields(fields, "meta");
  if (!input) return res.status(400).json({ error: "This lead's form has no website to rebuild. Add a website first, or design one from scratch in Mockups." });
  try {
    const { lead, duplicate } = intakeLead(input);
    l.mockupLeadId = lead.id;
    saveMetaLead(l);
    res.json({ leadId: lead.id, duplicate });
  } catch (e) {
    if (e instanceof DemoLimitError) return res.status(402).json({ error: e.message });
    throw e;
  }
});

const csvCell = (v: unknown) => {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@]/.test(s) && !/^\+?[\d\s().-]+$/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

meta.get("/export.csv", (req, res) => {
  const ids = typeof req.query.ids === "string" && req.query.ids ? new Set(req.query.ids.split(",")) : null;
  const rows = listMetaLeads().filter((l: MetaLead) => !ids || ids.has(l.id));
  const head = ["Name", "Email", "Phone", "Company", "Status", "Source", "Platform", "Campaign", "Ad", "Form", "Submitted", "Labels", "Notes"];
  const lines = rows.map((l) =>
    [l.name, l.email, l.phone, l.company, l.status, l.source, l.platform, l.campaign, l.adName, l.formName, l.submittedAt ?? l.createdAt, l.labels.join(" "), l.notes]
      .map(csvCell).join(","),
  );
  res.attachment(`meta-leads-${new Date().toISOString().slice(0, 10)}.csv`);
  res.type("text/csv").send([head.join(","), ...lines].join("\n"));
});
