import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isBareSpecifier, resolveFromNodeModules } from "../runtime/node-modules-resolve.mjs";

function project(t: { after: (fn: () => void) => void }, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cdpk-nmres-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const url = (path: string) => pathToFileURL(path).href;

test("isBareSpecifier tells packages from paths, URLs and builtins", () => {
  for (const spec of ["preact", "@scope/pkg", "lodash/fp", "@scope/pkg/sub/path.js"]) {
    assert.equal(isBareSpecifier(spec), true, spec);
  }
  for (const spec of ["./x.ts", "../x", "/abs/x.ts", "file:///x", "npm:x", "jsr:@a/b", "node:fs", "https://x/y.ts", "@/lib.ts"]) {
    assert.equal(isBareSpecifier(spec), false, spec);
  }
});

test("resolves main, module, and index.js fallbacks", (t) => {
  const root = project(t, {
    "node_modules/with-main/package.json": '{ "main": "lib/entry.js" }',
    "node_modules/with-main/lib/entry.js": "",
    "node_modules/with-module/package.json": '{ "module": "esm.js", "main": "cjs.js" }',
    "node_modules/with-module/esm.js": "",
    "node_modules/bare/package.json": "{}",
    "node_modules/bare/index.js": "",
  });
  assert.equal(resolveFromNodeModules("with-main", root), url(join(root, "node_modules/with-main/lib/entry.js")));
  assert.equal(resolveFromNodeModules("with-module", root), url(join(root, "node_modules/with-module/esm.js")));
  assert.equal(resolveFromNodeModules("bare", root), url(join(root, "node_modules/bare/index.js")));
});

test("exports: string, root entry, conditions in Deno's order", (t) => {
  const root = project(t, {
    "node_modules/str/package.json": '{ "exports": "./s.js" }',
    "node_modules/cond/package.json": JSON.stringify({
      exports: { ".": { require: "./c.cjs", deno: "./d.js", import: "./i.js", default: "./x.js" } },
    }),
    "node_modules/sugar/package.json": JSON.stringify({ exports: { import: "./i.js", default: "./x.js" } }),
    "node_modules/nested/package.json": JSON.stringify({
      exports: { ".": { node: { import: "./node-esm.js", require: "./node.cjs" }, default: "./x.js" } },
    }),
  });
  assert.equal(resolveFromNodeModules("str", root), url(join(root, "node_modules/str/s.js")));
  // deno comes before import/default, as Deno resolves npm packages.
  assert.equal(resolveFromNodeModules("cond", root), url(join(root, "node_modules/cond/d.js")));
  assert.equal(resolveFromNodeModules("sugar", root), url(join(root, "node_modules/sugar/i.js")));
  assert.equal(resolveFromNodeModules("nested", root), url(join(root, "node_modules/nested/node-esm.js")));
});

test("exports subpaths, including * patterns", (t) => {
  const root = project(t, {
    "node_modules/sub/package.json": JSON.stringify({
      exports: { ".": "./main.js", "./jsx-runtime": { import: "./jsx/runtime.mjs" }, "./icons/*": "./dist/icons/*.js" },
    }),
  });
  assert.equal(resolveFromNodeModules("sub/jsx-runtime", root), url(join(root, "node_modules/sub/jsx/runtime.mjs")));
  assert.equal(resolveFromNodeModules("sub/icons/star", root), url(join(root, "node_modules/sub/dist/icons/star.js")));
  // A subpath the exports map doesn't list is not importable.
  assert.equal(resolveFromNodeModules("sub/private.js", root), null);
});

test("without exports a subpath is a file inside the package", (t) => {
  const root = project(t, {
    "node_modules/open/package.json": "{}",
    "node_modules/open/fp/map.js": "",
  });
  assert.equal(resolveFromNodeModules("open/fp/map.js", root), url(join(root, "node_modules/open/fp/map.js")));
});

test("scoped packages, and walking up from a nested notebook directory", (t) => {
  const root = project(t, {
    "node_modules/@scope/pkg/package.json": '{ "exports": "./e.js" }',
    "notebooks/deep/.keep": "",
  });
  assert.equal(
    resolveFromNodeModules("@scope/pkg", join(root, "notebooks/deep")),
    url(join(root, "node_modules/@scope/pkg/e.js")),
  );
});

test("a symlinked package (Deno's nodeModulesDir: auto layout) resolves", (t) => {
  const root = project(t, {
    "node_modules/.deno/linked@1.0.0/node_modules/linked/package.json": '{ "main": "m.js" }',
    "node_modules/.deno/linked@1.0.0/node_modules/linked/m.js": "",
  });
  symlinkSync(join(root, "node_modules/.deno/linked@1.0.0/node_modules/linked"), join(root, "node_modules/linked"));
  assert.equal(resolveFromNodeModules("linked", root), url(join(root, "node_modules/linked/m.js")));
});

test("returns null when the package isn't in any node_modules", (t) => {
  const root = project(t, { "package.json": "{}" });
  assert.equal(resolveFromNodeModules("not-installed-anywhere-cdpk", root), null);
});

test("exports arrays fall back to the first usable target", (t) => {
  const root = project(t, {
    "node_modules/arr/package.json": JSON.stringify({ exports: { ".": [{ worker: "./w.js" }, "./fallback.js"] } }),
  });
  assert.equal(resolveFromNodeModules("arr", root), url(join(root, "node_modules/arr/fallback.js")));
});

test("a package exported only for require() isn't importable", (t) => {
  const root = project(t, {
    "node_modules/cjs-only/package.json": JSON.stringify({ exports: { ".": { require: "./c.cjs" } } }),
    "node_modules/cjs-pattern/package.json": JSON.stringify({ exports: { "./*": { require: "./*.cjs" } } }),
  });
  assert.equal(resolveFromNodeModules("cjs-only", root), null);
  assert.equal(resolveFromNodeModules("cjs-pattern/x", root), null);
});

test("non-bare specifiers are never resolved from node_modules", (t) => {
  const root = project(t, { "node_modules/x/package.json": "{}" });
  assert.equal(resolveFromNodeModules("./x", root), null);
  assert.equal(resolveFromNodeModules("npm:x", root), null);
});
