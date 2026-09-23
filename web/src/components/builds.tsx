import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Home, Plus, X } from "lucide-react";
import type { BuildStatus } from "../../../shared/types";

const LABEL: Record<BuildStatus, string> = {
  draft: "Draft", queued: "Queued", running: "Building", paused: "Paused", ready: "Ready", needs_review: "Needs review", failed: "Failed",
};

export function BuildStatusPill({ status }: { status: BuildStatus }) {
  const cls = status === "draft" ? "draft" : status;
  return <span className={`status ${cls}`}><span className="dot" />{LABEL[status]}</span>;
}

export interface PageDraft {
  title: string;
  brief: string;
}

export const PAGE_PRESETS: PageDraft[] = [
  { title: "About", brief: "Who they are, their story, values and why customers choose them" },
  { title: "Services", brief: "Overview of every service with a short description and a call to action" },
  { title: "Contact", brief: "Phone, email, address, opening hours, a simple contact form and a map link" },
  { title: "FAQ", brief: "Common customer questions answered from the details provided" },
  { title: "Portfolio", brief: "Selected projects or work examples using the real images available" },
  { title: "Testimonials", brief: "Real customer reviews only, taken verbatim from the details or site" },
  { title: "Pricing", brief: "Packages or rates, only as provided in the project details" },
  { title: "Team", brief: "The people behind the business, only as described in the details" },
  { title: "Service area", brief: "The towns and regions they serve" },
  { title: "Process", brief: "How working with them goes, step by step" },
  { title: "Careers", brief: "Open roles and what it's like to work there" },
  { title: "Blog", brief: "An index page introducing their articles (no invented posts)" },
];

export const DEFAULT_PAGES: PageDraft[] = [
  { title: "Home", brief: "The approved homepage" },
  PAGE_PRESETS[0],
  PAGE_PRESETS[1],
  PAGE_PRESETS[3],
  PAGE_PRESETS[2],
];

/** Editable page list. The homepage is fixed in first place. */
export function PagesEditor({ pages, onChange, max = 12 }: { pages: PageDraft[]; onChange: (p: PageDraft[]) => void; max?: number }) {
  const update = (i: number, patch: Partial<PageDraft>) => onChange(pages.map((p, n) => (n === i ? { ...p, ...patch } : p)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 1 || j >= pages.length) return;
    const next = [...pages];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const unused = PAGE_PRESETS.filter((p) => !pages.some((x) => x.title.toLowerCase() === p.title.toLowerCase()));

  return (
    <div className="pages-editor">
      {pages.map((p, i) => (
        <div key={i} className={`page-row${i === 0 ? " fixed" : ""}`}>
          <span className="page-num">{i === 0 ? <Home /> : i + 1}</span>
          <div className="page-fields">
            <input className="input" aria-label={`Page ${i + 1} name`} value={p.title} disabled={i === 0} placeholder="Page name" onChange={(e) => update(i, { title: e.target.value })} />
            <input className="input" aria-label={`What page ${i + 1} should cover`} value={p.brief} disabled={i === 0} placeholder="What this page should cover" onChange={(e) => update(i, { brief: e.target.value })} />
          </div>
          {i > 0 ? (
            <div className="page-tools">
              <button type="button" className="icon-btn sm" aria-label="Move up" title="Move up" onClick={() => move(i, -1)} disabled={i === 1}><ArrowUp /></button>
              <button type="button" className="icon-btn sm" aria-label={`Remove ${p.title || "page"}`} title="Remove" onClick={() => onChange(pages.filter((_, n) => n !== i))}><X /></button>
            </div>
          ) : <span className="muted page-fixed-note">Always included</span>}
        </div>
      ))}
      <div className="preset-chips">
        {unused.slice(0, 8).map((p) => (
          <button key={p.title} type="button" className="chip chip-btn" disabled={pages.length >= max} onClick={() => onChange([...pages, p])}><Plus />{p.title}</button>
        ))}
        <button type="button" className="chip chip-btn" disabled={pages.length >= max} onClick={() => onChange([...pages, { title: "", brief: "" }])}><Plus />Custom page</button>
      </div>
      <span className="hint">{pages.length} pages · the homepage plus up to {max - 1} more. Most sites land between 5 and 10.</span>
    </div>
  );
}

/** Scales a 1440px-wide page into the available width, like the mockup review panes. */
export function PreviewFrame({ src, view, title }: { src: string; view: "desktop" | "mobile"; title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return (
    <div className={`viewport ${view}`} style={{ height: 720 }}>
      <div className="scroller" ref={ref}>
        {w > 0 && (view === "desktop" ? (
          <div className="scale-wrap" style={{ ["--s" as string]: w / 1440 }}><iframe title={title} src={src} sandbox="allow-scripts" /></div>
        ) : (
          <iframe title={title} src={src} sandbox="allow-scripts" />
        ))}
      </div>
    </div>
  );
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="set-field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
