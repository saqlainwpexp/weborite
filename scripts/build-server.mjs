// Bundle the TypeScript server into app-dist/server.mjs for the desktop app (packages stay external).
//   node scripts/build-server.mjs            customer build: license always enforced
//   node scripts/build-server.mjs --owner    owner build: license check skipped (never share this one)
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const owner = process.argv.includes("--owner");
await build({
  entryPoints: [join(root, "server", "index.ts")],
  outfile: join(root, "app-dist", "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: "linked",
  logLevel: "warning",
  // Baked in at build time so no environment variable can change licensing in a shipped app.
  define: { __STUDIO_BUILD__: JSON.stringify(owner ? "owner" : "customer") },
  // Some dependencies are CommonJS and expect require() to exist.
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
});

// The installed app imports this folder's data on its first launch.
writeFileSync(join(root, "electron", "build-info.json"), JSON.stringify({ projectData: join(root, "data"), builtAt: new Date().toISOString() }, null, 1));
console.log(`app-dist/server.mjs built (${owner ? "OWNER build: license check skipped, don't share it" : "customer build"})`);
