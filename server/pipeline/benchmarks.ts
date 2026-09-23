import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_DIR } from "../db.ts";
import { extractJson, runClaude } from "../claude/runner.ts";
import type { BenchmarkSet } from "../../shared/types.ts";

const COLORS = ["#886fe2", "#e47053", "#4f9a6e", "#c98a2b", "#3f7cc9", "#c2508a", "#5a8f93", "#8a6d4f"];

export function listBenchmarkSets(): BenchmarkSet[] {
  return readdirSync(BENCH_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(BENCH_DIR, f), "utf8")) as BenchmarkSet)
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function getBenchmarkSet(key: string): BenchmarkSet | null {
  const p = join(BENCH_DIR, `${key}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as BenchmarkSet) : null;
}

export function saveBenchmarkSet(set: BenchmarkSet) {
  writeFileSync(join(BENCH_DIR, `${set.vertical}.json`), JSON.stringify(set, null, 2));
}

/** Reuse the vertical's set if it exists, otherwise run the one-time research pass and store it. */
export async function ensureBenchmarks(
  leadId: string,
  cwd: string,
  vertical: { key: string; label: string; register: string },
): Promise<{ set: BenchmarkSet; created: boolean }> {
  const existing = getBenchmarkSet(vertical.key);
  if (existing) return { set: existing, created: false };

  const res = await runClaude({
    leadId,
    task: "benchmarks",
    cwd,
    web: true,
    system: "You research real, currently live websites. You never invent a site, a brand or a URL. You verify each one with web search before listing it.",
    prompt: `Build a benchmark set of best-in-class homepages for this business vertical.

Vertical: ${vertical.label}
Competitive register (what the buyer is evaluating): ${vertical.register}

Find 5–8 real, named businesses whose homepages are excellent examples for this register: strong hero, clear offer, trust signals, modern typography, and a good mobile layout. Include a mix of well-known leaders and smaller independent businesses of a similar size to a local business. Search the web to confirm each site exists and is live. Only include sites you confirmed.

For each one, write a single "why" line naming the specific homepage pattern worth learning from.

Return only JSON:
\`\`\`json
{"sites": [{"name": "...", "url": "https://...", "why": "..."}]}
\`\`\``,
  });
  const { sites } = extractJson<{ sites: BenchmarkSet["sites"] }>(res.text);
  const set: BenchmarkSet = {
    vertical: vertical.key,
    label: vertical.label,
    register: vertical.register,
    color: COLORS[listBenchmarkSets().length % COLORS.length],
    sites: sites.filter((s) => /^https?:\/\//.test(s.url)).slice(0, 8),
    createdAt: new Date().toISOString(),
  };
  saveBenchmarkSet(set);
  return { set, created: true };
}
