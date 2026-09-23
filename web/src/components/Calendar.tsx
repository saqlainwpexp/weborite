import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** Local-date key, e.g. 2026-09-22 (not UTC, so late-evening leads land on the right day). */
export function dayKey(d: Date | string) {
  const x = typeof d === "string" ? new Date(d) : d;
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

export function parseDayKey(k: string) {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Month grid. `counts` maps dayKey → number of leads received that day. */
export function Calendar({ selected, counts, onSelect }: { selected: string | null; counts: Record<string, number>; onSelect: (key: string) => void }) {
  const today = dayKey(new Date());
  const [cursor, setCursor] = useState(() => {
    const base = selected ? parseDayKey(selected) : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });

  const cells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7; // Monday first
    const start = new Date(first);
    start.setDate(1 - offset);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [cursor]);

  const shift = (n: number) => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + n, 1));
  const monthLabel = cursor.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  return (
    <div className="cal">
      <div className="cal-head">
        <button type="button" className="icon-btn cal-nav" aria-label="Previous month" onClick={() => shift(-1)}><ChevronLeft /></button>
        <b>{monthLabel}</b>
        <button type="button" className="icon-btn cal-nav" aria-label="Next month" onClick={() => shift(1)}><ChevronRight /></button>
      </div>
      <div className="cal-grid" role="grid" aria-label={monthLabel}>
        {WEEKDAYS.map((w) => <span key={w} className="cal-wd">{w}</span>)}
        {cells.map((d) => {
          const k = dayKey(d);
          const out = d.getMonth() !== cursor.getMonth();
          const n = counts[k] ?? 0;
          return (
            <button
              type="button"
              key={k}
              className={`cal-day${out ? " out" : ""}${k === today ? " today" : ""}${k === selected ? " on" : ""}`}
              aria-pressed={k === selected}
              aria-label={`${d.toLocaleDateString("en-US", { month: "long", day: "numeric" })}${n ? `, ${n} lead${n > 1 ? "s" : ""}` : ""}`}
              onClick={() => onSelect(k)}
            >
              {d.getDate()}
              {n > 0 && <i className="cal-dot" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
