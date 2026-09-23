import { Router } from "express";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./db.ts";
import type { CommsService } from "../shared/types.ts";

/**
 * Communication channels shown in the desktop app. Only names and addresses live here; each
 * channel's login lives in its own browser profile inside the desktop app, never in this file.
 */
const FILE = join(DATA, "comms.json");

export function listServices(): CommsService[] {
  return existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as CommsService[]) : [];
}

function save(list: CommsService[]) {
  writeFileSync(FILE, JSON.stringify(list, null, 1));
}

function clean(body: Record<string, unknown>, base?: CommsService): CommsService | string {
  let url = String(body.url ?? base?.url ?? "").trim();
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol)) return "Use a web address starting with https://";
  } catch {
    return "Enter the web address of the service, e.g. https://web.whatsapp.com";
  }
  const name = String(body.name ?? base?.name ?? "").trim().slice(0, 40);
  if (!name) return "Give the channel a name";
  const color = /^#[0-9a-f]{6}$/i.test(String(body.color ?? "")) ? String(body.color) : base?.color ?? "#6b6b6b";
  return {
    id: base?.id ?? randomUUID().slice(0, 8),
    kind: String(body.kind ?? base?.kind ?? "custom").slice(0, 20),
    name,
    url,
    color,
    notify: typeof body.notify === "boolean" ? body.notify : base?.notify ?? true,
    muted: typeof body.muted === "boolean" ? body.muted : base?.muted ?? false,
    createdAt: base?.createdAt ?? new Date().toISOString(),
  };
}

export const comms = Router();

comms.get("/", (_req, res) => res.json(listServices()));

comms.post("/", (req, res) => {
  const s = clean(req.body ?? {});
  if (typeof s === "string") return res.status(400).json({ error: s });
  const list = listServices();
  if (list.length >= 40) return res.status(400).json({ error: "That's a lot of channels: remove one first" });
  save([...list, s]);
  res.json(s);
});

comms.put("/:id", (req, res) => {
  const list = listServices();
  const i = list.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.sendStatus(404);
  const s = clean(req.body ?? {}, list[i]);
  if (typeof s === "string") return res.status(400).json({ error: s });
  list[i] = s;
  save(list);
  res.json(s);
});

/** New order of ids (drag to reorder). */
comms.put("/", (req, res) => {
  const ids: string[] = Array.isArray(req.body?.order) ? req.body.order.map(String) : [];
  const list = listServices();
  const sorted = [...ids.map((id) => list.find((x) => x.id === id)).filter((x): x is CommsService => Boolean(x)), ...list.filter((x) => !ids.includes(x.id))];
  save(sorted);
  res.json(sorted);
});

comms.delete("/:id", (req, res) => {
  save(listServices().filter((x) => x.id !== req.params.id));
  res.json({ ok: true });
});
