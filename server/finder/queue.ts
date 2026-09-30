import { addEvent } from "../db.ts";
import { Pool, parallel } from "../pool.ts";
import { searchMaps } from "./maps.ts";
import { checkWhatsappBusiness, scanWebsite, whatsappStatus } from "./enrich.ts";
import { queueQualify } from "./qualify.ts";
import {
  computeTags, findByPlace, getProspect, getSearch, insertProspect, listProspects, listSearches, refreshSearchCounts, saveProspect, saveSearch,
} from "./store.ts";

const cancelled = new Set<string>();
// Several searches run at once (Settings → Parallel searches); more at once makes Google Maps more likely to block.
const pool = new Pool<string>((id) => id, () => parallel("searches"), async (id) => {
  try {
    await runSearch(id);
  } finally {
    cancelled.delete(id);
  }
});

export function enqueueSearch(id: string) {
  if (!pool.isActive(id)) pool.push(id);
}

export function cancelSearch(id: string) {
  cancelled.add(id);
  pool.remove((x) => x === id);
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

    const cur = getSearch(id);
    if (!cur) return; // deleted mid-run
    cur.status = "enriching";
    saveSearch(cur);

    // Enrich three at a time: website scans are mostly network wait.
    const pending = listProspects({ searchId: id }).filter((p) => p.enrichStatus !== "done");
    for (let i = 0; i < pending.length && !cancelled.has(id); i += 3) {
      await Promise.all(pending.slice(i, i + 3).map((p) => enrichProspect(p.id)));
      refreshSearchCounts(id);
    }

    // Score every business: website audit + design review.
    if (!cancelled.has(id)) {
      const sc = getSearch(id);
      if (!sc) return; // deleted mid-run
      sc.status = "scoring";
      saveSearch(sc);
      await queueQualify(listProspects({ searchId: id }).filter((p) => p.fit?.status !== "done").map((p) => p.id));
    }

    const done = refreshSearchCounts(id);
    if (!done) return; // deleted mid-run
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
    const f = getSearch(id);
    if (!f) return; // deleted mid-run: nothing to mark
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
  for (const s of listSearches().reverse()) if (s.status === "queued" || s.status === "searching" || s.status === "enriching" || s.status === "scoring") enqueueSearch(s.id);
}
