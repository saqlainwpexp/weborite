// Bundle the TypeScript server into app-dist/server.mjs for the desktop app (packages stay external).
//   node scripts/build-server.mjs            customer build: license always enforced
//   node scripts/build-server.mjs --owner    owner build: license check skipped (never share this one)
import { build } from "esbuild";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import JavaScriptObfuscator from "javascript-obfuscator";
import { parse } from "acorn";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const owner = process.argv.includes("--owner");
if (!owner) checkLicenseKey();

/**
 * A customer build needs the license server's public key in shared/licenseKey.ts. Editors on Windows can
 * save it as UTF-16 or with a stray space or line break inside the quotes: clean those up (rewriting the
 * file as plain UTF-8) and explain exactly what's wrong when the key still isn't usable.
 */
function checkLicenseKey() {
  const file = join(root, "shared", "licenseKey.ts");
  // CI (the release workflow) passes the key in LICENSE_PUBLIC_KEY; a local build uses the one saved in the file.
  const fromEnv = (process.env.LICENSE_PUBLIC_KEY ?? "").trim();
  if (fromEnv) {
    const current = readFileSync(file, "utf8");
    writeFileSync(file, current.replace(/LICENSE_PUBLIC_KEY\s*=\s*["'`][^"'`]*["'`]/, `LICENSE_PUBLIC_KEY = "${fromEnv}"`), "utf8");
  }
  const buf = readFileSync(file);
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString("utf16le") : buf.toString("utf8").replace(/^\uFEFF/, "");
  const m = text.match(/LICENSE_PUBLIC_KEY\s*=\s*["'`]([^"'`]*)["'`]/);
  const fail = (why) => {
    console.error(`shared/licenseKey.ts: ${why}\nCopy the App public key from the bottom of studio.weborite.com/license/ (the Copy button), then run:\n  (Get-Content shared\\licenseKey.ts) -replace 'LICENSE_PUBLIC_KEY = ".*"', 'LICENSE_PUBLIC_KEY = "YOUR_KEY"' | Set-Content -Encoding utf8 shared\\licenseKey.ts`);
    process.exit(1);
  };
  if (!m) fail("no line like  export const LICENSE_PUBLIC_KEY = \"...\";  was found.");
  const key = m[1].replace(/\s+/g, "");
  if (!key) fail("LICENSE_PUBLIC_KEY is still empty.");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, "base64").length !== 32)
    fail(`the key doesn't look right: it has ${key.length} characters ("${key.slice(0, 6)}…${key.slice(-4)}"); a public key is 44 characters ending in "=".`);
  const clean = text.slice(0, m.index) + `LICENSE_PUBLIC_KEY = "${key}"` + text.slice(m.index + m[0].length);
  if (clean !== buf.toString("utf8")) {
    writeFileSync(file, clean, "utf8");
    console.log("shared/licenseKey.ts: cleaned up the key and saved the file as UTF-8");
  }
}
await build({
  entryPoints: [join(root, "server", "index.ts")],
  outfile: join(root, "app-dist", "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  // Customer builds ship one minified file with no source map and no comments; the owner build keeps a map for debugging.
  minify: !owner,
  sourcemap: owner ? "linked" : false,
  legalComments: "none",
  logLevel: "warning",
  // Baked in at build time so no environment variable can change licensing in a shipped app.
  define: { __STUDIO_BUILD__: JSON.stringify(owner ? "owner" : "customer") },
  // Some dependencies are CommonJS and expect require() to exist.
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
});

// Customer builds: encode every string (the Claude prompts, rules and messages) so the shipped file can't
// simply be searched or read, and drop any source map an earlier owner build left behind.
if (!owner) {
  const out = join(root, "app-dist", "server.mjs");
  const code = keepBrowserCodePlain(readFileSync(out, "utf8"));
  const obf = JavaScriptObfuscator.obfuscate(code, {
    target: "node",
    compact: true,
    identifierNamesGenerator: "mangled",
    renameGlobals: false,
    stringArray: true,
    stringArrayThreshold: 1,
    stringArrayEncoding: ["base64"],
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 1,
    // Heavier transforms (control-flow flattening, dead code, self-defending) slow the pipeline and can break it.
    controlFlowFlattening: false,
    deadCodeInjection: false,
    selfDefending: false,
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
  }).getObfuscatedCode();
  writeFileSync(out, obf);
  rmSync(`${out}.map`, { force: true });
}

/**
 * Functions handed to Playwright (page.evaluate, $$eval, waitForFunction…) run inside the web page, where the
 * obfuscator's string decoder doesn't exist: "ReferenceError: hE is not defined". Wrap each of them, inline or
 * passed by name, in the obfuscator's disable/enable comments so they ship as they are.
 */
function keepBrowserCodePlain(code) {
  const BROWSER = new Set(["evaluate", "evaluateHandle", "$eval", "$$eval", "evalOnSelector", "evalOnSelectorAll", "waitForFunction", "addInitScript"]);
  const isFn = (n) => n && (n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression");
  const ast = parse(code, { ecmaVersion: "latest", sourceType: "module" });
  const byName = new Map(); // function name → its function nodes (declarations and const x = () => …)
  const calls = [];
  const walk = (n) => {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "FunctionDeclaration" && n.id) byName.set(n.id.name, [...(byName.get(n.id.name) ?? []), n]);
    if (n.type === "VariableDeclarator" && n.id.type === "Identifier" && isFn(n.init)) byName.set(n.id.name, [...(byName.get(n.id.name) ?? []), n.init]);
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && !n.callee.computed && BROWSER.has(n.callee.property.name)) calls.push(n);
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === "string" && k !== "loc") walk(v);
    }
  };
  walk(ast);
  const targets = [];
  let byRef = 0;
  for (const c of calls) {
    for (const a of c.arguments) {
      if (isFn(a)) targets.push(a);
      else if (a.type === "Identifier" && byName.has(a.name)) {
        targets.push(...byName.get(a.name));
        byRef++;
      }
    }
  }
  // Outermost ranges only, applied from the end so earlier offsets stay valid.
  const ranges = [...new Map(targets.map((t) => [t.start, [t.start, t.end]])).values()].sort((a, b) => a[0] - b[0]);
  const outer = ranges.filter((r, i) => !ranges.some((o, j) => j !== i && o[0] <= r[0] && o[1] >= r[1] && (o[0] !== r[0] || o[1] !== r[1])));
  let outCode = code;
  for (const [a, b] of outer.sort((x, y) => y[0] - x[0])) {
    outCode = outCode.slice(0, a) + "/* javascript-obfuscator:disable */" + outCode.slice(a, b) + "/* javascript-obfuscator:enable */" + outCode.slice(b);
  }
  console.log(`Browser-side functions kept readable: ${outer.length} (${byRef} passed by name) in ${calls.length} Playwright calls`);
  return outCode;
}

// The installed app imports this folder's data on its first launch.
writeFileSync(join(root, "electron", "build-info.json"), JSON.stringify({ projectData: join(root, "data"), builtAt: new Date().toISOString() }, null, 1));
console.log(`app-dist/server.mjs built (${owner ? "OWNER build: license check skipped, don't share it" : "customer build"})`);
