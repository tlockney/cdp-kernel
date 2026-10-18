// Bundles the browser target for a page: dist/browser/kernel.js (the
// kernel, from src/browser/mod.ts) and dist/browser/worker.js (the driver
// Worker, from runtime/browser-worker.mjs). Both are ES modules.
//
//   node scripts/build-browser.mjs [outdir]

import { readFileSync } from "node:fs";
import { build } from "esbuild";

const outdir = process.argv[2] ?? "dist/browser";
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Node-only modules the kernel's files import but a page never runs. */
const browserStubs = {
  name: "browser-stubs",
  setup(b) {
    // src/package.ts imports Node; the kernel needs only its VERSION.
    b.onResolve({ filter: /\/package\.ts$/ }, () => ({ path: "package", namespace: "stub" }));
    b.onLoad({ filter: /^package$/, namespace: "stub" }, () => ({ contents: `export const VERSION = ${JSON.stringify(version)};` }));
    // esbuild's native binary: the default type stripper, which the page
    // replaces with sucrase. Loading it says so.
    b.onResolve({ filter: /^esbuild$/ }, () => ({ path: "esbuild", namespace: "stub" }));
    b.onLoad({ filter: /^esbuild$/, namespace: "stub" }, () => ({
      contents: `export function transformSync() { throw new Error("esbuild can't strip types in a browser; use typeStrip: \\"sucrase\\""); }`,
    }));
  },
};

const common = { bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "warning", sourcemap: true };
await build({ ...common, entryPoints: { kernel: "src/browser/mod.ts" }, outdir, plugins: [browserStubs] });
// A cell's import() goes to whatever URL it names; esbuild warns that it
// can't follow one it can't see.
await build({ ...common, entryPoints: { worker: "runtime/browser-worker.mjs" }, outdir, logOverride: { "unsupported-dynamic-import": "silent" } });
console.log(`built ${outdir}/kernel.js and ${outdir}/worker.js`);
