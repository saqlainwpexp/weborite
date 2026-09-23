import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA } from "./db.ts";

const CACHE = join(DATA, "google-fonts.json");
const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "emoji", "math", "inherit", "initial"]);

// Used only if Google's list can't be fetched and nothing is cached.
const FALLBACK = ["Inter", "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins", "Source Sans 3", "Source Serif 4", "Merriweather", "Playfair Display", "Lora", "Libre Caslon Text", "Libre Baskerville", "DM Sans", "DM Serif Display", "Work Sans", "Manrope", "Nunito Sans", "Raleway", "Oswald", "Archivo", "Fraunces", "Cormorant Garamond", "EB Garamond", "Space Grotesk", "Plus Jakarta Sans", "Outfit", "Barlow", "Rubik", "Karla"];

let families: Set<string> | null = null;

/** Every family on Google Fonts (cached for a week in data/google-fonts.json). */
export async function googleFonts(): Promise<Set<string>> {
  if (families) return families;
  const fresh = existsSync(CACHE) && Date.now() - statSync(CACHE).mtimeMs < 7 * 86400_000;
  if (!fresh) {
    try {
      const res = await fetch("https://fonts.google.com/metadata/fonts", { signal: AbortSignal.timeout(30000) });
      const text = await res.text();
      const list = (JSON.parse(text.slice(text.indexOf("{"))) as { familyMetadataList: { family: string }[] }).familyMetadataList.map((f) => f.family);
      if (list.length > 500) writeFileSync(CACHE, JSON.stringify(list));
    } catch {
      /* keep whatever is cached */
    }
  }
  const list: string[] = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : FALLBACK;
  families = new Set(list.map((f) => f.toLowerCase()));
  return families;
}

/** First real family in a CSS font-family stack, e.g. `"Iowan Old Style", Georgia, serif` → Iowan Old Style. */
export function primaryFamily(stack: string) {
  return stack.split(",")[0].trim().replace(/^["']|["']$/g, "");
}

export function isGoogleFamily(name: string, set: Set<string>) {
  const n = name.toLowerCase();
  return GENERIC.has(n) || set.has(n);
}
