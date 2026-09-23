/** Derive the whole UI palette from one brand colour, keeping every text pairing WCAG AA. */

export const DEFAULT_BRAND = "#a36566";
const STORE_KEY = "studio.brand";

type RGB = [number, number, number];

const hexToRgb = (h: string): RGB => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbToHex = ([r, g, b]: RGB) => "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

function luminance(h: string) {
  const c = hexToRgb(h).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/** Mix toward black (amount < 0) or white (amount > 0). */
function mix(h: string, amount: number): string {
  const target = amount < 0 ? 0 : 255;
  const t = Math.abs(amount);
  return rgbToHex(hexToRgb(h).map((v) => v + (target - v) * t) as RGB);
}

/** Darken step by step until `fg` reaches `ratio` against the result. */
function darkenUntil(h: string, fg: string, ratio: number) {
  let c = h;
  for (let i = 0; i < 40 && contrast(fg, c) < ratio; i++) c = mix(c, -0.04);
  return c;
}

export function isHex(v: string) {
  return /^#[0-9a-f]{6}$/i.test(v);
}

export function brandPalette(brand: string) {
  const base = isHex(brand) ? brand.toLowerCase() : DEFAULT_BRAND;
  const whiteOk = contrast("#ffffff", base) >= 4.5;
  const darkText = "#141213";
  const onBrand = whiteOk ? "#ffffff" : darkText;
  const accent = darkenUntil(base, "#ffffff", 4.5); // filled buttons with white text
  return {
    "--brand": base,
    "--on-brand": onBrand,
    "--on-brand-muted": whiteOk ? "rgba(255, 255, 255, .86)" : "rgba(20, 18, 19, .78)",
    "--brand-overlay": whiteOk ? "rgba(255, 255, 255, .14)" : "rgba(20, 18, 19, .07)",
    "--brand-overlay-strong": whiteOk ? "rgba(255, 255, 255, .24)" : "rgba(20, 18, 19, .12)",
    "--brand-line": whiteOk ? "rgba(255, 255, 255, .24)" : "rgba(20, 18, 19, .14)",
    "--brand-ink": darkenUntil(base, "#ffffff", 6), // brand-coloured text on white
    "--accent": accent,
    "--accent-hover": mix(accent, -0.1),
    "--accent-soft": mix(base, 0.88),
    "--accent-softer": mix(base, 0.94),
    meta: { onBrand, whiteOk, accentAdjusted: accent !== base },
  };
}

export function applyBrand(brand: string) {
  const { meta: _meta, ...vars } = brandPalette(brand);
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(vars)) root.setProperty(k, v as string);
  try {
    localStorage.setItem(STORE_KEY, brand);
  } catch {
    /* storage unavailable */
  }
}

/** Apply the last-known colour before first paint, so there's no flash of the default. */
export function applyStoredBrand() {
  try {
    const b = localStorage.getItem(STORE_KEY);
    if (b && isHex(b)) applyBrand(b);
  } catch {
    /* storage unavailable */
  }
}

export const BRAND_PRESETS = ["#a36566", "#2f5d50", "#1f4e79", "#5b4b8a", "#b4532a", "#1d1d1f", "#c9a227", "#0f766e"];
