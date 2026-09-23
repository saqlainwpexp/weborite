import type { BidderConfig, BidProject } from "../../shared/types.ts";

type PriceCfg = Pick<BidderConfig, "floorPct" | "ceilPct" | "openBudgetFactor">;

/** The client's range. A project with only a minimum gets max = min × openBudgetFactor. */
export function bidRange(p: Pick<BidProject, "budget">, cfg: Pick<BidderConfig, "openBudgetFactor">) {
  const lo = Math.max(0, p.budget.min);
  const max = p.budget.max && p.budget.max >= lo ? p.budget.max : lo * Math.max(1, cfg.openBudgetFactor);
  return { lo, hi: Math.max(lo, max) };
}

/** Keep any amount inside the range, as a whole number. */
export function clampAmount(p: Pick<BidProject, "budget">, amount: number, cfg: Pick<BidderConfig, "openBudgetFactor">) {
  const { lo, hi } = bidRange(p, cfg);
  return Math.min(Math.floor(hi), Math.max(Math.ceil(lo), Math.round(amount)));
}

/**
 * Where to bid: simple jobs land at floorPct of the range, complex ones at ceilPct.
 * Defaults (50% → 90%) mean "the middle of the range or above", never over the maximum.
 */
export function suggestAmount(p: Pick<BidProject, "budget">, complexity: number, cfg: PriceCfg) {
  const { lo, hi } = bidRange(p, cfg);
  const c = Math.min(1, Math.max(0, Number.isFinite(complexity) ? complexity : 0.5));
  const floor = Math.min(100, Math.max(0, cfg.floorPct)) / 100;
  const ceil = Math.min(100, Math.max(floor * 100, cfg.ceilPct)) / 100;
  const raw = lo + (hi - lo) * (floor + (ceil - floor) * c);
  // Round to a price a person would type (…$245, $250, $1,450).
  const step = raw >= 1000 ? 50 : raw >= 200 ? 10 : raw >= 50 ? 5 : 1;
  return clampAmount(p, Math.round(raw / step) * step, cfg);
}
