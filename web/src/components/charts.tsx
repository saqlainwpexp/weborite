import { useState } from "react";

/**
 * Single-series column chart: one brand hue, thin columns with rounded 4px tops on the baseline,
 * a recessive grid, a tooltip on hover/focus for every column, and a table view.
 */
export function ColumnChart({ data, format, label, height = 190 }: { data: { label: string; value: number }[]; format: (n: number) => string; label: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = Math.max(...data.map((d) => d.value), 0);
  // A "nice" top for the axis so gridlines land on round numbers.
  const step = max <= 0 ? 1 : 10 ** Math.floor(Math.log10(max));
  const top = max <= 0 ? 1 : Math.ceil(max / step) * step;
  const W = 640;
  const H = height;
  const padL = 48;
  const padB = 26;
  const plotW = W - padL - 8;
  const plotH = H - padB - 10;
  const slot = plotW / data.length;
  const barW = Math.min(34, slot - 2 * 2 - 6);
  const y = (v: number) => 10 + plotH - (v / top) * plotH;

  if (table) {
    return (
      <div>
        <div className="chart-bar"><span className="muted">{label}</span><button type="button" className="link-btn" onClick={() => setTable(false)}>Chart</button></div>
        <div className="table-wrap"><table className="table chart-table"><thead><tr><th>Period</th><th style={{ textAlign: "right" }}>{label}</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.label}><td>{d.label}</td><td style={{ textAlign: "right" }}>{format(d.value)}</td></tr>)}</tbody></table></div>
      </div>
    );
  }
  return (
    <div className="chart">
      <div className="chart-bar"><span className="muted">{label}</span><button type="button" className="link-btn" onClick={() => setTable(true)}>Table</button></div>
      <div className="chart-plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}: ${data.map((d) => `${d.label} ${format(d.value)}`).join(", ")}`} preserveAspectRatio="none">
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={padL} x2={W - 8} y1={y(top * f)} y2={y(top * f)} className={f === 0 ? "chart-base" : "chart-grid"} />
              <text x={padL - 8} y={y(top * f) + 4} textAnchor="end" className="chart-axis">{format(top * f)}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = padL + slot * i + slot / 2;
            const h = Math.max(d.value > 0 ? 2 : 0, y(0) - y(d.value));
            const x = cx - barW / 2;
            const r = Math.min(4, h, barW / 2);
            const yTop = y(0) - h;
            return (
              <g key={d.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0} aria-label={`${d.label}: ${format(d.value)}`}>
                <rect x={padL + slot * i} y={10} width={slot} height={plotH} fill="transparent" />
                {h > 0 && <path d={`M${x},${y(0)} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${y(0)} Z`} className={`chart-col${hover === i ? " on" : ""}`} />}
                {(i % Math.ceil(data.length / 8) === 0 || i === data.length - 1) && <text x={cx} y={H - 6} textAnchor="middle" className="chart-axis">{d.label}</text>}
              </g>
            );
          })}
        </svg>
        {hover !== null && (
          <div className="chart-tip" style={{ left: `${((padL + slot * hover + slot / 2) / W) * 100}%`, top: `${(y(data[hover].value) / H) * 100}%` }} role="status">
            <b>{format(data[hover].value)}</b><span>{data[hover].label}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Stage-to-stage funnel: one hue, bar length = count, with the step conversion rate. */
export function Funnel({ stages }: { stages: { stage: string; count: number }[] }) {
  const max = Math.max(1, ...stages.map((s) => s.count));
  return (
    <ol className="funnel">
      {stages.map((s, i) => {
        const prev = i ? stages[i - 1].count : null;
        return (
          <li key={s.stage}>
            <span className="funnel-label">{s.stage}</span>
            <span className="funnel-track"><span className="funnel-fill" style={{ width: `${Math.max(s.count ? 2 : 0, (s.count / max) * 100)}%` }} /></span>
            <b className="funnel-count">{s.count}</b>
            <span className="funnel-rate muted">{prev ? `${Math.round((s.count / prev) * 100)}%` : ""}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function money(n: number, currency: string, compact = false) {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, currencyDisplay: "narrowSymbol", maximumFractionDigits: compact || Number.isInteger(n) ? 0 : 2, notation: compact && n >= 10000 ? "compact" : "standard" }).format(n);
  } catch {
    return `${currency} ${n.toFixed(0)}`;
  }
}

/** "+12%" vs the previous period, or nothing when there's no baseline. */
export function Delta({ now, prev }: { now: number; prev: number | null }) {
  if (prev === null) return null;
  if (!prev) return now ? <span className="delta up">new</span> : null;
  const pct = Math.round(((now - prev) / prev) * 100);
  return <span className={`delta ${pct > 0 ? "up" : pct < 0 ? "down" : ""}`}>{pct > 0 ? "▲" : pct < 0 ? "▼" : ""} {Math.abs(pct)}%</span>;
}
