import { randomUUID } from "node:crypto";
import { sqlite as db } from "../db.ts";
import type { MetaActivity, MetaLead, MetaLeadSource, MetaLeadStats, MetaLeadStatus } from "../../shared/types.ts";
import { META_LEAD_STATUS, META_TAG } from "../../shared/types.ts";

db.exec(`
  CREATE TABLE IF NOT EXISTS meta_leads (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL,
    leadgen_id TEXT UNIQUE, data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS meta_leads_created ON meta_leads(created_at);
`);

const newId = () => randomUUID().slice(0, 8);

/** Fields a caller may supply; the rest are filled with sensible blanks. */
export type MetaLeadInput = Partial<Omit<MetaLead, "id" | "createdAt">> & { source: MetaLeadSource };

/** Every lead in this workspace is a Meta/ad lead, so it always carries the "Meta ads" tag. */
function withMetaTag(labels: string[] = []): string[] {
  return labels.some((l) => l.toLowerCase() === META_TAG.toLowerCase()) ? labels : [META_TAG, ...labels];
}

function fill(input: MetaLeadInput): Omit<MetaLead, "id" | "createdAt"> {
  return {
    source: input.source,
    submittedAt: input.submittedAt,
    name: (input.name ?? "").trim(),
    email: (input.email ?? "").trim(),
    phone: (input.phone ?? "").trim(),
    company: (input.company ?? "").trim(),
    website: (input.website ?? "").trim(),
    campaign: (input.campaign ?? "").trim(),
    adName: (input.adName ?? "").trim(),
    formName: (input.formName ?? "").trim(),
    platform: (input.platform ?? "").trim(),
    fields: input.fields ?? {},
    status: input.status ?? "new",
    labels: withMetaTag(input.labels),
    notes: input.notes ?? "",
    activity: input.activity ?? [],
    followUpAt: input.followUpAt,
    mockupLeadId: input.mockupLeadId,
    meta: input.meta,
  };
}

/** Append a pipeline timeline entry (and keep followUpAt in sync for follow-ups). Caller saves. */
export function logMetaActivity(lead: MetaLead, entry: Omit<MetaActivity, "at"> & { at?: string }) {
  const at = entry.at ?? new Date().toISOString();
  lead.activity = [{ ...entry, at }, ...(lead.activity ?? [])];
  if (entry.kind === "follow_up") lead.followUpAt = entry.dueAt || undefined;
}

/**
 * Insert a lead. De-dupes on the platform leadgen id (so a webhook retry doesn't double up)
 * and, for CSV/manual leads, on a non-empty email. Returns the stored (or existing) lead.
 */
export function createMetaLead(input: MetaLeadInput): { lead: MetaLead; duplicate: boolean } {
  const body = fill(input);
  const leadgenId = body.meta?.leadgenId;
  if (leadgenId) {
    const r = db.prepare("SELECT data FROM meta_leads WHERE leadgen_id = ?").get(leadgenId) as { data: string } | undefined;
    if (r) return { lead: JSON.parse(r.data), duplicate: true };
  } else if (body.email) {
    const existing = listMetaLeads().find((l) => l.email && l.email.toLowerCase() === body.email.toLowerCase());
    if (existing) return { lead: existing, duplicate: true };
  }
  const lead: MetaLead = { ...body, id: newId(), createdAt: new Date().toISOString() };
  db.prepare("INSERT INTO meta_leads (id, created_at, status, leadgen_id, data) VALUES (?, ?, ?, ?, ?)").run(
    lead.id, lead.createdAt, lead.status, leadgenId ?? null, JSON.stringify(lead),
  );
  return { lead, duplicate: false };
}

export function saveMetaLead(lead: MetaLead) {
  db.prepare("UPDATE meta_leads SET status = ?, data = ? WHERE id = ?").run(lead.status, JSON.stringify(lead), lead.id);
}

/** Backfill fields added after a lead was first stored, so older rows stay valid. */
function hydrate(lead: MetaLead): MetaLead {
  lead.website = lead.website ?? "";
  lead.activity = lead.activity ?? [];
  lead.labels = withMetaTag(lead.labels ?? []);
  return lead;
}

export function getMetaLead(id: string): MetaLead | null {
  const r = db.prepare("SELECT data FROM meta_leads WHERE id = ?").get(id) as { data: string } | undefined;
  return r ? hydrate(JSON.parse(r.data)) : null;
}

export function listMetaLeads(): MetaLead[] {
  return (db.prepare("SELECT data FROM meta_leads ORDER BY created_at DESC").all() as { data: string }[]).map((r) => hydrate(JSON.parse(r.data)));
}

export function deleteMetaLead(id: string) {
  db.prepare("DELETE FROM meta_leads WHERE id = ?").run(id);
}

export function metaLeadStats(): MetaLeadStats {
  const all = listMetaLeads();
  const byStatus = Object.fromEntries(META_LEAD_STATUS.map((s) => [s.key, 0])) as Record<MetaLeadStatus, number>;
  for (const l of all) byStatus[l.status] = (byStatus[l.status] ?? 0) + 1;
  return {
    total: all.length,
    byStatus,
    withEmail: all.filter((l) => l.email).length,
    withPhone: all.filter((l) => l.phone).length,
  };
}

// ---- Field mapping (CSV columns & Graph API field_data → a MetaLead) ----

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Header aliases → the MetaLead property they fill. Everything else lands in `fields`. */
const ALIASES: Record<string, keyof MetaLead | "firstName" | "lastName"> = {
  fullname: "name", name: "name", yourname: "name", contactname: "name",
  firstname: "firstName", first: "firstName",
  lastname: "lastName", last: "lastName", surname: "lastName",
  email: "email", emailaddress: "email", workemail: "email", mail: "email",
  phone: "phone", phonenumber: "phone", mobile: "phone", mobilenumber: "phone", whatsapp: "phone", whatsappnumber: "phone",
  company: "company", companyname: "company", business: "company", businessname: "company", organization: "company", organisation: "company",
  website: "website", websiteurl: "website", url: "website", site: "website", web: "website", domain: "website", webpage: "website",
  campaign: "campaign", campaignname: "campaign",
  ad: "adName", adname: "adName",
  form: "formName", formname: "formName",
  platform: "platform",
  createdtime: "submittedAt", created: "submittedAt", createdat: "submittedAt", submittedat: "submittedAt", time: "submittedAt",
};

/** Build a MetaLead input from arbitrary form/CSV fields. Unmapped, non-empty columns are kept. */
export function metaLeadFromFields(fields: Record<string, string>, source: MetaLeadSource, extra: Partial<MetaLeadInput> = {}): MetaLeadInput {
  const out: MetaLeadInput = { source, fields: {}, ...extra };
  let firstName = "", lastName = "";
  for (const [rawKey, rawVal] of Object.entries(fields)) {
    const val = (rawVal ?? "").trim();
    if (!val) continue;
    const target = ALIASES[norm(rawKey)];
    if (target === "firstName") firstName = val;
    else if (target === "lastName") lastName = val;
    else if (target === "submittedAt") out.submittedAt = out.submittedAt ?? val;
    else if (target) (out as Record<string, unknown>)[target] = val;
    else out.fields![rawKey] = val;
  }
  if (!out.name && (firstName || lastName)) out.name = [firstName, lastName].filter(Boolean).join(" ");
  return out;
}

/** Split CSV text into rows of cells (handles quoted cells, escaped quotes and CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", inQuotes = false;
  const s = text.replace(/^﻿/, ""); // strip BOM
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); if (row.some((x) => x !== "")) rows.push(row); }
  return rows;
}

/** Import a CSV export into Meta Leads. Returns how many were added vs. skipped as duplicates. */
export function importMetaCsv(text: string): { imported: number; skipped: number } {
  const rows = parseCsv(text);
  if (rows.length < 2) return { imported: 0, skipped: 0 };
  const headers = rows[0];
  let imported = 0, skipped = 0;
  for (const cells of rows.slice(1)) {
    const fields: Record<string, string> = {};
    headers.forEach((h, i) => { if (h.trim()) fields[h.trim()] = cells[i] ?? ""; });
    const input = metaLeadFromFields(fields, "csv");
    if (!input.name && !input.email && !input.phone) { skipped++; continue; }
    const { duplicate } = createMetaLead(input);
    duplicate ? skipped++ : imported++;
  }
  return { imported, skipped };
}
