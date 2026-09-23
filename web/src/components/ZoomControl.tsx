import { useEffect, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { desktop } from "../lib/desktop";

const KEY = "studio.zoom";
const clamp = (z: number) => Math.round(Math.min(1.5, Math.max(0.5, z)) * 100) / 100;

/** Floating − / % / + in the bottom corner. The desktop app zooms everything (channels too); a browser tab uses CSS zoom. */
export function ZoomControl() {
  const [zoom, setZoomState] = useState<number>(() => {
    if (desktop) return 0.9;
    try {
      return Number(localStorage.getItem(KEY)) || 1;
    } catch {
      return 1;
    }
  });

  useEffect(() => {
    if (desktop) {
      void desktop.zoom.get().then(setZoomState);
      return desktop.zoom.onChange(setZoomState);
    }
    document.documentElement.style.setProperty("zoom", String(zoom));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (z: number) => {
    const next = clamp(z);
    if (desktop) {
      void desktop.zoom.set(next).then(setZoomState);
      return;
    }
    setZoomState(next);
    document.documentElement.style.setProperty("zoom", String(next));
    try {
      localStorage.setItem(KEY, String(next));
    } catch {
      /* not remembered */
    }
  };
  const base = desktop ? 0.9 : 1;

  return (
    <div className="zoom-ctl" role="group" aria-label="Zoom">
      <button type="button" aria-label="Zoom out" title="Zoom out (Ctrl −)" disabled={zoom <= 0.5} onClick={() => set(zoom - 0.1)}><Minus /></button>
      <button type="button" className="zoom-val" title={`Reset to ${Math.round(base * 100)}% (Ctrl 0)`} onClick={() => set(base)}>{Math.round(zoom * 100)}%</button>
      <button type="button" aria-label="Zoom in" title="Zoom in (Ctrl +)" disabled={zoom >= 1.5} onClick={() => set(zoom + 0.1)}><Plus /></button>
    </div>
  );
}
