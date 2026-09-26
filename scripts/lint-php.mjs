// Syntax-check the connector's PHP without a local PHP install: node scripts/lint-php.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import PhpParser from "php-parser";

const parser = new PhpParser({ parser: { php8: true, suppressErrors: false }, ast: { withPositions: true } });
const dir = join(import.meta.dirname, "..", "server", "wp", "php");
let failed = 0;
for (const f of ["care.php", "woo.php", "staging-mu.php"]) {
  try {
    parser.parseCode(readFileSync(join(dir, f), "utf8"), f);
    console.log(`ok    ${f}`);
  } catch (e) {
    failed++;
    console.log(`error ${f}: ${e.message}`);
  }
}

// The main plugin file is generated from TypeScript: render it and check that too.
const { renderMainPhp } = await import("../server/wp/plugin.ts").catch(() => ({}));
if (renderMainPhp) {
  try {
    parser.parseCode(renderMainPhp(), "studio-connector.php");
    console.log("ok    studio-connector.php (generated)");
  } catch (e) {
    failed++;
    console.log(`error studio-connector.php: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
