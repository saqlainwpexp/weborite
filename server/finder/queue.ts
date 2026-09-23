import { addEvent } from "../db.ts";
import { searchMaps } from "./maps.ts";
import { checkWhatsappBusiness, scanWebsite, whatsappStatus } from "./enrich.ts";
import {
  computeTags, findByPlace, getProspect, getSearch, insertProspect, listProspects, listSearches, refreshSearchCounts, saveProspect, saveSearch,
} from "./store.ts";

const queue: string[] = [];
let running: string | null = null;
const cancelled = new Set<string>();

export function enqueueSearch(id: string) {
  if (!queue.includes(id) && running !== id) queue.push(id);
  void pump();
}

export function cancelSearch(id: string) {
  cancelled.add(id);
  const i = queue.indexOf(id);
  if (i >= 0) queue.splice(i, 1);
}

async function pump() {
  if (running) return;
  const id = queue.shift();
  if (!id) return;
  running = id;
  try {
    await runSearch(id);
  } finally {
    running = null;
    cancelled.delete(id);
    void pump();
  }
}

export async function enrichProspect(id: string) {
  const p = getProspect(id);
  if (!p) return;
  p.enrichStatus = "running";
  saveProspect(p);
  try {
    const site = p.website ? await scanWebsite(p.website) : { emails: [], pages: [], waLink: false, note: "No website listed" };
    const waName = p.phone.startsWith("+") ? await checkWhatsappBusiness(p.phone) : null;
    p.emails = site.emails;
    p.emailPages = site.pages;
    p.whatsapp = whatsappStatus(p.phone, waName, site.waLink);
    p.whatsappName = waName ?? "";
    p.tags = computeTags(p);
    p.enrichStatus = "done";
    p.enrichNote = site.note;
  } catch (e) {
    p.enrichStatus = "failed";
    p.enrichNote = (e as Error).message.slice(0, 160);
    p.tags = computeTags(p);
  }
  saveProspect(p);
}

async function runSearch(id: string) {
  const s = getSearch(id);
  if (!s) return;
  s.status = "searching";
  s.error = undefined;
  saveSearch(s);

  try {
    let skipped = 0;
    await searchMaps(s.query, s.max, {
      shouldStop: () => cancelled.has(id),
      onLinks: () => {},
      onPlace: (place) => {
        // A business found by an earlier search is kept once, not duplicated.
        if (findByPlace(place.placeId)) {
          skipped++;
          return;
        }
        insertProspect({
          ...place, searchId: id, source: "google_maps",
          emails: [], emailPages: [], whatsapp: "pending", whatsappName: "",
          tags: computeTags({ emails: [], whatsapp: "pending", website: place.website }),
          enrichStatus: "pending",
        });
        refreshSearchCounts(id);
      },
    });

    const cur = getSearch(id)!;
    cur.status = "enriching";
    saveSearch(cur);

    // Enrich three at a time: website scans are mostly network wait.
    const pending = listProspects({ searchId: id }).filter((p) => p.enrichStatus !== "done");
    for (let i = 0; i < pending.length && !cancelled.has(id); i += 3) {
      await Promise.all(pending.slice(i, i + 3).map((p) => enrichProspect(p.id)));
      refreshSearchCounts(id);
    }

    const done = refreshSearchCounts(id)!;
    done.status = cancelled.has(id) ? "failed" : "done";
    if (cancelled.has(id)) done.error = "Stopped";
    done.finishedAt = new Date().toISOString();
    saveSearch(done);
    addEvent({
      leadId: null,
      kind: "info",
      title: "Lead search finished",
      detail: `${done.query}: ${done.found} leads, ${done.withEmail} with email, ${done.withWhatsapp} on WhatsApp${skipped ? ` (${skipped} already found earlier)` : ""}`,
    });
  } catch (e) {
    const f = getSearch(id)!;
    f.status = "failed";
    f.error = (e as Error).message.slice(0, 300);
    f.finishedAt = new Date().toISOString();
    saveSearch(f);
    addEvent({ leadId: null, kind: "failed", title: "Lead search failed", detail: `${f.query}: ${f.error}` });
    console.error(`[finder ${id}]`, e);
  }
}

/** After a restart, finish anything that was interrupted. */
export function resumeSearches() {
  for (const s of listSearches().reverse()) if (s.status === "queued" || s.status === "searching" || s.status === "enriching") enqueueSearch(s.id);
}
