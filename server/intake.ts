import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import { addEvent, createLead, findDuplicate, getSettings, normalizeUrl } from "./db.ts";
import { enqueue } from "./queue.ts";
import type { Lead, LeadSource } from "../shared/types.ts";

const pick = (fields: Record<string, string>, re: RegExp) => Object.entries(fields).find(([k, v]) => re.test(k) && v.trim())?.[1]?.trim() ?? "";

function looksLikeDomain(v: string) {
  return /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(v.trim()) && !v.includes("@");
}

/** Map arbitrary form fields to a lead. Returns null when no website URL is present. */
export function leadFromFields(fields: Record<string, string>, source: LeadSource) {
  let url = pick(fields, /web|url|site|domain|link/i);
  if (!url) url = Object.values(fields).find(looksLikeDomain) ?? "";
  if (!url) return null;
  let normalized: string;
  try {
    normalized = normalizeUrl(url);
  } catch {
    return null;
  }
  const first = pick(fields, /^first|first.?name/i);
  const last = pick(fields, /^last|last.?name|surname/i);
  return {
    source,
    url: normalized,
    name: pick(fields, /^(full.?)?name$|your.?name|contact.?name/i) || [first, last].filter(Boolean).join(" "),
    email: pick(fields, /e-?mail/i),
    phone: pick(fields, /phone|mobile|tel|whats/i),
    business: pick(fields, /business|company|brand|organi[sz]ation|shop|store/i),
    fields,
  };
}

export function intakeLead(input: NonNullable<ReturnType<typeof leadFromFields>> & { mode?: Lead["mode"]; prospectId?: string }): { lead: Lead; duplicate: boolean } {
  const dup = findDuplicate(input.url, input.email);
  if (dup) return { lead: dup, duplicate: true };
  const lead = createLead(input);
  addEvent({ leadId: lead.id, kind: "lead", title: "New lead added", detail: lead.mode === "scratch" ? `${lead.business}: no website, designing from its Google Maps listing` : `${lead.name || lead.email || "Someone"} submitted ${new URL(lead.url).hostname} via ${input.source}` });
  enqueue(lead.id);
  return { lead, duplicate: false };
}

/** Elementor Pro sends urlencoded or JSON, either flat by label or as fields[id][value]. */
function flattenElementor(body: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const fields = body.fields as Record<string, { value?: string; title?: string; raw_value?: string }> | undefined;
  if (fields && typeof fields === "object") {
    for (const [id, f] of Object.entries(fields)) out[f?.title || id] = String(f?.value ?? f?.raw_value ?? "");
  }
  for (const [k, v] of Object.entries(body)) {
    if (k === "fields" || k === "form" || k === "meta") continue;
    const m = k.match(/^fields\[(.+?)\]\[(value|raw_value)\]$/);
    if (m) out[m[1]] = String(v);
    else if (typeof v === "string") out[k] = v;
  }
  return out;
}

export const hooks = Router();

hooks.post("/elementor", (req, res) => {
  const s = getSettings();
  if (req.query.key !== s.elementorSecret) return res.status(403).json({ error: "bad key" });
  const fields = flattenElementor(req.body ?? {});
  const input = leadFromFields(fields, "elementor");
  if (!input) {
    addEvent({ leadId: null, kind: "info", title: "Elementor submission skipped", detail: "No website URL field found" });
    return res.json({ ok: true, skipped: "no url" });
  }
  const { lead, duplicate } = intakeLead(input);
  res.json({ ok: true, id: lead.id, duplicate });
});

// Meta webhook verification handshake.
hooks.get("/meta", (req, res) => {
  const s = getSettings();
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === s.metaVerifyToken) {
    return res.status(200).send(String(req.query["hub.challenge"]));
  }
  res.sendStatus(403);
});

function validMetaSignature(req: Request, secret: string) {
  const sig = req.get("x-hub-signature-256");
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!sig || !raw) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

hooks.post("/meta", async (req, res) => {
  const s = getSettings();
  if (s.metaAppSecret && !validMetaSignature(req, s.metaAppSecret)) return res.sendStatus(403);
  res.sendStatus(200); // Meta retries on slow responses; acknowledge first.
  const leadIds: string[] = [];
  for (const entry of req.body?.entry ?? []) for (const ch of entry.changes ?? []) if (ch.field === "leadgen" && ch.value?.leadgen_id) leadIds.push(ch.value.leadgen_id);
  for (const lid of leadIds) {
    try {
      if (!s.metaPageToken) throw new Error("No Meta Page access token saved in Settings");
      const r = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(lid)}?fields=field_data,created_time`, {
        headers: { Authorization: `Bearer ${s.metaPageToken}` },
      });
      const data = (await r.json()) as { field_data?: { name: string; values: string[] }[]; error?: { message: string } };
      if (!r.ok || !data.field_data) throw new Error(data.error?.message ?? `Graph API ${r.status}`);
      const fields = Object.fromEntries(data.field_data.map((f) => [f.name, f.values.join(", ")]));
      const input = leadFromFields(fields, "meta");
      if (!input) {
        addEvent({ leadId: null, kind: "info", title: "Meta lead skipped", detail: "The lead form has no website URL answer" });
        continue;
      }
      intakeLead(input);
    } catch (e) {
      addEvent({ leadId: null, kind: "failed", title: "Meta lead fetch failed", detail: (e as Error).message.slice(0, 140) });
    }
  }
});
