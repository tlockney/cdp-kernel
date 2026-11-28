// Pure unit tests for browser package type resolution helpers and
// NotebookTypesCore remote module registration (#525).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import {
  isFetchableSpecifier,
  packageJsonCandidates,
  parsePackageName,
  referenceCandidates,
  resolvePackageTypesField,
  rewriteRootReferencePaths,
  virtualPathForUrl,
} from "../src/browser/package-types.ts";
import { kernelGlobals, NotebookTypesCore, posixJoin, type TypesFileSystem } from "../src/notebook-types-core.ts";

const LIB = dirname(ts.getDefaultLibFilePath({}));

function memory(extra: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(extra));
  for (const name of readdirSync(LIB)) {
    if (/^lib\..*\.d\.ts$/.test(name)) files.set(`/lib/${name}`, readFileSync(join(LIB, name), "utf8"));
  }
  const fs: TypesFileSystem = {
    readFile: (path) => files.get(path),
    fileExists: (path) => files.has(path),
    directoryExists: (path) => [...files.keys()].some((f) => f.startsWith(`${path}/`)),
    getDirectories: () => [],
  };
  return { fs, files };
}

test("isFetchableSpecifier skips relative, data and blob URLs unless mapped", () => {
  assert.equal(isFetchableSpecifier("npm:date-fns@4"), true);
  assert.equal(isFetchableSpecifier("jsr:@std/path"), true);
  assert.equal(isFetchableSpecifier("https://esm.sh/zod@3"), true);
  assert.equal(isFetchableSpecifier("lodash"), true);
  assert.equal(isFetchableSpecifier("./local.ts"), false);
  assert.equal(isFetchableSpecifier("../up.ts"), false);
  assert.equal(isFetchableSpecifier("/abs.ts"), false);
  assert.equal(isFetchableSpecifier("data:text/javascript,export default 1"), false);
  assert.equal(isFetchableSpecifier("blob:https://example.com/123"), false);
  assert.equal(isFetchableSpecifier("./mapped.mjs", { "./mapped.mjs": "/vendor/mapped.mjs" }), true);
});

test("virtualPathForUrl maps HTTP URLs to POSIX /types paths preserving extensions", () => {
  assert.equal(
    virtualPathForUrl("https://esm.sh/v135/date-fns@4.1.0/index.d.ts"),
    "/types/https/esm.sh/v135/date-fns@4.1.0/index.d.ts",
  );
  assert.equal(
    virtualPathForUrl("http://127.0.0.1:8080/cdn/pkg@1/sub.d.mts?target=es2022"),
    "/types/http/127.0.0.1_8080/cdn/pkg@1/sub.d.mts",
  );
  assert.equal(
    virtualPathForUrl("https://example.com/types"),
    "/types/https/example.com/types.d.ts",
  );
  assert.equal(virtualPathForUrl("not a url"), null);
});

test("parsePackageName splits package, version and subpath", () => {
  assert.deepEqual(parsePackageName("zod"), { pkg: "zod", subpath: "" });
  assert.deepEqual(parsePackageName("zod@3.24.0"), { pkg: "zod@3.24.0", subpath: "" });
  assert.deepEqual(parsePackageName("zod@3.24.0/mini"), { pkg: "zod@3.24.0", subpath: "mini" });
  assert.deepEqual(parsePackageName("@std/path@1.0.0/posix"), { pkg: "@std/path@1.0.0", subpath: "posix" });
  assert.deepEqual(parsePackageName("@std/path"), { pkg: "@std/path", subpath: "" });
});

test("packageJsonCandidates finds package.json URLs for npm:, jsr:, bare and HTTP specifiers", () => {
  assert.deepEqual(packageJsonCandidates("npm:@scope/pkg@1/sub", "https://esm.sh/@scope/pkg@1/sub", "https://esm.sh/"), [
    { manifestUrl: "https://esm.sh/@scope/pkg@1/package.json", subpath: "./sub" },
  ]);
  assert.deepEqual(packageJsonCandidates("jsr:@std/path@1", "https://esm.sh/jsr/@std/path@1", "https://esm.sh/"), [
    { manifestUrl: "https://esm.sh/jsr/@std/path@1/package.json", subpath: "." },
  ]);
  assert.deepEqual(
    packageJsonCandidates("https://cdn.example.com/pkg@1", "https://cdn.example.com/pkg@1", "https://esm.sh/"),
    [{ manifestUrl: "https://cdn.example.com/pkg@1/package.json", subpath: "." }],
  );
  assert.deepEqual(
    packageJsonCandidates("https://cdn.example.com/pkg@1?target=es2022", "https://cdn.example.com/pkg@1?target=es2022", "https://esm.sh/"),
    [{ manifestUrl: "https://cdn.example.com/pkg@1/package.json", subpath: "." }],
  );
  assert.deepEqual(
    packageJsonCandidates("node:events", "https://esm.sh/node:events", "https://esm.sh/"),
    [{ manifestUrl: "https://esm.sh/node:events/package.json", subpath: "." }],
  );
});

test("resolvePackageTypesField reads exports conditions, types and typings", () => {
  assert.equal(
    resolvePackageTypesField({ exports: { ".": { import: { types: "./dist/index.d.mts", default: "./dist/index.mjs" } } } }, "."),
    "./dist/index.d.mts",
  );
  assert.equal(
    resolvePackageTypesField({ exports: { "./sub": { types: "./sub.d.ts", default: "./sub.js" } }, types: "./index.d.ts" }, "./sub"),
    "./sub.d.ts",
  );
  assert.equal(resolvePackageTypesField({ types: "./dist/index.d.ts" }, "."), "./dist/index.d.ts");
  assert.equal(resolvePackageTypesField({ typings: "lib/main.d.ts" }, "."), "lib/main.d.ts");
  assert.equal(resolvePackageTypesField({ main: "./index.js" }, "."), null);
});

test("referenceCandidates and rewriteRootReferencePaths handle relative and root-relative refs", () => {
  assert.deepEqual(referenceCandidates("./sub.js", "https://esm.sh/pkg@1/index.d.ts"), [
    "https://esm.sh/pkg@1/sub.d.ts",
    "https://esm.sh/pkg@1/sub.ts",
  ]);
  assert.deepEqual(referenceCandidates("./sub", "https://esm.sh/pkg@1/index.d.ts"), [
    "https://esm.sh/pkg@1/sub.d.ts",
    "https://esm.sh/pkg@1/sub.d.mts",
    "https://esm.sh/pkg@1/sub/index.d.ts",
    "https://esm.sh/pkg@1/sub/index.d.mts",
  ]);
  assert.equal(
    rewriteRootReferencePaths('/// <reference path="/v135/other/index.d.ts" />\nexport {};\n', "/types/https/esm.sh"),
    '/// <reference path="/types/https/esm.sh/v135/other/index.d.ts" />\nexport {};\n',
  );
});

test("NotebookTypesCore resolves registered remote modules even after a prior unresolved lookup", () => {
  const { fs, files } = memory();
  const seen: string[] = [];
  const types = new NotebookTypesCore(
    ts,
    { notebookDir: "/notebook", npmCache: null, types: [], typeFiles: [], globals: kernelGlobals(null) },
    { fs, join: posixJoin, libDir: "/lib", onImportSpecifiers: (specs) => seen.push(...specs) },
  );

  // Before types arrive: unresolved package stays any (0 diagnostics) and notifies host.
  const code = 'import { add } from "npm:pkg@1";\nconst s: string = add(1, 2);';
  assert.deepEqual(types.diagnostics(code, 5_000), []);
  assert.ok(seen.includes("npm:pkg@1"));

  // Register virtual declaration files (including a root-relative import inside esm.sh).
  files.set("/types/https/esm.sh/v135/shared/index.d.ts", "export type Sum = number;\n");
  files.set(
    "/types/https/esm.sh/v135/pkg@1/index.d.ts",
    'import type { Sum } from "/v135/shared/index.d.ts";\nexport function add(a: number, b: number): Sum;\n',
  );
  types.addResolvedModule("npm:pkg@1", "/types/https/esm.sh/v135/pkg@1/index.d.ts");

  // Module resolution cache is invalidated so diagnostics now flags TS2322.
  const diags = types.diagnostics(code, 5_000);
  assert.deepEqual(diags?.map((d) => d.code), [2322]);
});
