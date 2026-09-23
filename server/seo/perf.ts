import lighthouse from "lighthouse";
import desktopConfig from "lighthouse/core/config/desktop-config.js";
import { chromium } from "playwright";
import { newContext } from "../pipeline/browser.ts";
import { mobileChecks, navToggleCheck } from "../pipeline/capture.ts";
import type { PerfMetrics, PerfPage, PerfResult } from "../../shared/types.ts";
import { UA } from "./crawl.ts";

type Lhr = NonNullable<Awaited<ReturnType<typeof lighthouse>>>["lhr"];

async function runLh(url: string, desktop: boolean): Promise<Lhr | null> {
  const port = 9300 + Math.floor(Math.random() * 600);
  const browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] });
  try {
    const r = await lighthouse(
      url,
      { port, output: "json", logLevel: "error", onlyCategories: ["performance", "best-practices"] },
      desktop ? desktopConfig : undefined,
    );
    return r?.lhr ?? null;
  } catch (e) {
    console.warn("[lighthouse]", url, (e as Error).message);
    return null;
  } finally {
    await browser.close().catch(() => {});
  }
}

const num = (lhr: Lhr, id: string) => Math.round(Number(lhr.audits[id]?.numericValue ?? 0));

function metrics(lhr: Lhr): PerfMetrics {
  const items = ((lhr.audits["resource-summary"]?.details as { items?: { resourceType: string; transferSize: number; requestCount: number }[] })?.items) ?? [];
  const byType: Record<string, number> = {};
  for (const i of items) if (i.resourceType !== "total") byType[i.resourceType] = i.transferSize;
  const total = items.find((i) => i.resourceType === "total");
  return {
    score: Math.round((lhr.categories.performance?.score ?? 0) * 100),
    lcp: num(lhr, "largest-contentful-paint"),
    cls: Math.round(Number(lhr.audits["cumulative-layout-shift"]?.numericValue ?? 0) * 1000) / 1000,
    tbt: num(lhr, "total-blocking-time"),
    fcp: num(lhr, "first-contentful-paint"),
    si: num(lhr, "speed-index"),
    ttfb: num(lhr, "server-response-time"),
    weight: total?.transferSize ?? num(lhr, "total-byte-weight"),
    requests: total?.requestCount ?? 0,
    byType,
  };
}

/** Real-user Core Web Vitals (CrUX) via the free PageSpeed Insights API. */
async function fieldData(url: string, key: string): Promise<PerfPage["field"]> {
  try {
    const q = new URLSearchParams({ url, strategy: "mobile", category: "performance" });
    if (key) q.set("key", key);
    const r = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, { signal: AbortSignal.timeout(90000) });
    const d = (await r.json()) as {
      loadingExperience?: { metrics?: Record<string, { percentile: number }>; overall_category?: string };
      originLoadingExperience?: { metrics?: Record<string, { percentile: number }>; overall_category?: string };
      error?: { message: string };
    };
    if (d.error) return { source: `PageSpeed API: ${d.error.message.slice(0, 120)}` };
    const pick = d.loadingExperience?.metrics ? { m: d.loadingExperience.metrics, cat: d.loadingExperience.overall_category, src: "Real users of this page (CrUX, 28 days)" }
      : d.originLoadingExperience?.metrics ? { m: d.originLoadingExperience.metrics, cat: d.originLoadingExperience.overall_category, src: "Real users across the whole site (CrUX origin)" } : null;
    if (!pick) return { source: "No real-user data yet. Google needs more traffic before it reports Core Web Vitals." };
    const p = (k: string) => pick.m[k]?.percentile;
    return {
      lcp: p("LARGEST_CONTENTFUL_PAINT_MS"),
      inp: p("INTERACTION_TO_NEXT_PAINT"),
      cls: p("CUMULATIVE_LAYOUT_SHIFT_SCORE") !== undefined ? p("CUMULATIVE_LAYOUT_SHIFT_SCORE")! / 100 : undefined,
      fcp: p("FIRST_CONTENTFUL_PAINT_MS"),
      ttfb: p("EXPERIMENTAL_TIME_TO_FIRST_BYTE"),
      category: pick.cat,
      source: pick.src,
    };
  } catch (e) {
    return { source: `PageSpeed API unreachable: ${(e as Error).message.slice(0, 80)}` };
  }
}

async function experience(url: string, lhr: Lhr | null): Promise<PerfPage["experience"]> {
  const ctx = await newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, userAgent: UA });
  let mobileIssues: string[] = [];
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 40000 });
    const checks = [...(await page.evaluate(mobileChecks)), await navToggleCheck(page)];
    mobileIssues = checks.filter((c) => !c.pass).map((c) => c.detail);
  } catch {
    mobileIssues = ["Page didn't load on a phone-sized screen"];
  } finally {
    await ctx.close();
  }
  const consoleItems = ((lhr?.audits["errors-in-console"]?.details as { items?: unknown[] })?.items ?? []).length;
  return {
    https: url.startsWith("https://") && (lhr ? lhr.audits["is-on-https"]?.score !== 0 : true),
    viewport: lhr ? lhr.audits["viewport"]?.score !== 0 : true,
    mobileIssues,
    consoleErrors: consoleItems,
  };
}

async function gtmetrix(url: string, key: string): Promise<PerfResult["gtmetrix"]> {
  const auth = "Basic " + Buffer.from(`${key}:`).toString("base64");
  const headers = { Authorization: auth, "Content-Type": "application/vnd.api+json" };
  try {
    const start = await fetch("https://gtmetrix.com/api/2.0/tests", {
      method: "POST", headers, body: JSON.stringify({ data: { type: "test", attributes: { url } } }), signal: AbortSignal.timeout(30000),
    });
    const s = (await start.json()) as { data?: { id: string }; errors?: { title: string; detail?: string }[] };
    if (!s.data) return { error: s.errors?.map((e) => e.detail || e.title).join("; ") || `GTmetrix ${start.status}` };
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const t = await fetch(`https://gtmetrix.com/api/2.0/tests/${s.data.id}`, { headers, redirect: "manual" });
      const loc = t.headers.get("location");
      const body = t.status === 303 && loc ? await (await fetch(loc, { headers })).json() : await t.json();
      const data = (body as { data?: { type: string; attributes: Record<string, unknown>; links?: Record<string, string> } }).data;
      if (data?.type === "report") {
        const a = data.attributes as Record<string, number & string>;
        return {
          url, grade: a.gtmetrix_grade, performance: a.performance_score, structure: a.structure_score,
          lcp: a.largest_contentful_paint, tbt: a.total_blocking_time, cls: a.cumulative_layout_shift,
          fullyLoaded: a.fully_loaded_time, bytes: a.page_bytes, requests: a.page_requests, report: data.links?.report_url ?? "",
        };
      }
      const state = (data?.attributes as { state?: string } | undefined)?.state;
      if (state === "error") return { error: String((data?.attributes as { error?: string }).error ?? "GTmetrix test failed") };
    }
    return { error: "GTmetrix test timed out" };
  } catch (e) {
    return { error: (e as Error).message.slice(0, 120) };
  }
}

/** Lab + field performance and page experience for every page (desktop lab on the first 15). */
export async function runPerf(urls: string[], keys: { psi: string; gtmetrix: string }, onProgress: (done: number) => void): Promise<PerfResult> {
  const pages: PerfPage[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const mobileLhr = await runLh(url, false);
    const desktopLhr = i < 15 ? await runLh(url, true) : null;
    pages.push({
      url,
      mobile: mobileLhr ? metrics(mobileLhr) : null,
      desktop: desktopLhr ? metrics(desktopLhr) : null,
      field: i < 10 ? await fieldData(url, keys.psi) : null,
      experience: await experience(url, mobileLhr),
    });
    onProgress(i + 1);
  }
  return { pages, gtmetrix: keys.gtmetrix ? await gtmetrix(urls[0], keys.gtmetrix) : null };
}
