import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";

export function useClickAway<T extends HTMLElement>(open: boolean, onAway: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onAway();
    const k = (e: KeyboardEvent) => e.key === "Escape" && onAway();
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [open, onAway]);
  return ref;
}

export interface DropdownOption {
  value: string;
  label: string;
  hint?: string;
  swatch?: string;
}

/** Styled select: white trigger button + popover list, matching the top bar menus. */
export function Dropdown({
  value, options, onChange, label, icon, align = "left", width = 260, field = false, id,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  label: string;
  icon?: ReactNode;
  align?: "left" | "right";
  width?: number;
  /** Render as a full-width form field instead of a toolbar button. */
  field?: boolean;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useClickAway<HTMLDivElement>(open, () => setOpen(false));
  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <div className={`pop-anchor${field ? " dd-block" : ""}`} ref={ref}>
      <button type="button" id={id} className={field ? "dd-field" : "btn btn-white dropdown-trigger"} aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)}>
        {icon}
        {current?.swatch && <i className="dd-swatch" style={{ background: current.swatch }} />}
        <span>{current?.label}</span>
        <ChevronDown className={`dd-chevron${open ? " up" : ""}`} />
      </button>
      {open && (
        <div className={`popover menu${align === "right" ? " right" : ""}`} style={{ width: field ? "100%" : width }} role="listbox" aria-label={label}>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`menu-item${o.value === value ? " on" : ""}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.swatch !== undefined && <i className="dd-swatch" style={{ background: o.swatch || "var(--faint)" }} />}
              <span className="menu-text">
                <b>{o.label}</b>
                {o.hint && <small>{o.hint}</small>}
              </span>
              {o.value === value && <Check className="menu-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
