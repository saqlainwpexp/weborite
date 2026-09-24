import { rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Trim things electron ships that Weborite Studio doesn't need, to shrink the installer:
 *  - LICENSES.chromium.html (~20 MB legal text, not required to run)
 *  - any leftover locale .pak beyond en-US (electronLanguages usually handles this)
 */
export default async function afterPack(context) {
  const dir = context.appOutDir;
  const licenses = join(dir, "LICENSES.chromium.html");
  if (existsSync(licenses)) {
    rmSync(licenses, { force: true });
    console.log("  • afterPack: removed LICENSES.chromium.html");
  }
  const locales = join(dir, "locales");
  if (existsSync(locales)) {
    let removed = 0;
    for (const f of readdirSync(locales)) {
      if (f !== "en-US.pak" && f.endsWith(".pak")) {
        rmSync(join(locales, f), { force: true });
        removed++;
      }
    }
    if (removed) console.log(`  • afterPack: removed ${removed} extra locale files`);
  }
}
