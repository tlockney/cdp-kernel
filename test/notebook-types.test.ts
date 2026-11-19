// The language service over a notebook's cells (#273), src/notebook-types.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { kernelGlobals, NotebookTypes } from "../src/notebook-types.ts";
import { aliasFor } from "../runtime/node-hooks.mjs";

const repo = join(import.meta.dirname, "..");
const display = join(repo, "runtime", "display.mjs");

function service(options: { notebookDir?: string; npmCache?: "npm" | "bun" | null; types?: string[] } = {}) {
  return new NotebookTypes(ts, {
    notebookDir: options.notebookDir ?? repo,
    npmCache: options.npmCache === undefined ? "npm" : options.npmCache,
    types: options.types ?? [],
    typeFiles: [],
    globals: kernelGlobals(display),
  });
}

function names(types: NotebookTypes, code: string, cursor = code.length): string[] {
  return types.complete(code, cursor).entries.map((e) => e.name);
}

test("completes members from declared types, not values", () => {
  const types = service();
  types.addCell("interface User { name: string; age: number }\nlet u: User | undefined;");
  assert.deepEqual(names(types, "u!."), ["age", "name"]);
});

test("a redeclared name has its newest type", () => {
  const types = service();
  types.addCell("const x = 1;");
  types.addCell("const x = 'now a string';");
  const members = names(types, "x.");
  assert.ok(members.includes("toUpperCase"), members.join());
  assert.ok(!members.includes("toFixed"));
});

test("the edited cell's declarations replace the history's", () => {
  // Re-running a cell: its old version is in the history.
  const types = service();
  types.addCell("const cfg = { port: 80 };");
  assert.deepEqual(names(types, "const cfg = { host: 'x' };\ncfg."), ["host"]);
});

test("completes inside expressions and filters by the typed prefix", () => {
  const types = service();
  const code = "[1, 2].map((n) => n.toF";
  const result = types.complete(code, code.length);
  assert.deepEqual(result.entries.map((e) => e.name), ["toFixed"]);
  assert.equal(result.start, code.length - "toF".length);
  assert.equal(result.entries[0].kind, "method");
});

test("names declared in earlier cells complete, keywords don't", () => {
  const types = service();
  types.addCell("function addNumbers(a: number, b: number) { return a + b; }");
  assert.deepEqual(names(types, "addN"), ["addNumbers"]);
  assert.ok(!names(types, "con").includes("const"));
});

test("top-level await in a cell doesn't stop completion", () => {
  const types = service();
  types.addCell("const data = await Promise.resolve({ rows: [1] });");
  assert.deepEqual(names(types, "data."), ["rows"]);
});

test("the kernel's globals are typed", () => {
  const types = service();
  const members = names(types, "jupyter.");
  for (const name of ["display", "md", "html", "image"]) assert.ok(members.includes(name), members.join());
  assert.deepEqual(names(types, "promp"), ["prompt"]);
});

test("reset forgets the history", () => {
  const types = service();
  types.addCell("const gone = 1;");
  types.reset();
  assert.deepEqual(names(types, "gon"), []);
});

test("type packages resolve from the notebook's directory", () => {
  const types = service({ types: ["node"] });
  assert.ok(types.resolvesTypes("node"));
  assert.ok(names(types, "process.versi").includes("versions"));
  assert.ok(!service({ notebookDir: mkdtempSync(join(tmpdir(), "cdpk-nb-")) }).resolvesTypes("node"));
});

test("npm: and jsr: imports resolve to the kernel's npm cache, without installing", () => {
  const cache = mkdtempSync(join(tmpdir(), "cdpk-cache-"));
  const saved = process.env.CDPK_CACHE_DIR;
  process.env.CDPK_CACHE_DIR = cache;
  try {
    const install = (name: string, range: string, dts: string) => {
      const dir = join(cache, "node_modules", aliasFor(name, range));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", types: "index.d.ts" }));
      writeFileSync(join(dir, "index.d.ts"), dts);
    };
    install("fake-pkg", "1", "export declare const fakeValue: { alpha: number; beta: string };");
    install("@jsr/std__fake", "*", "export declare function fakeJoin(...parts: string[]): string;");
    const types = service({ notebookDir: mkdtempSync(join(tmpdir(), "cdpk-nb-")) });
    types.addCell(`import { fakeValue } from "npm:fake-pkg@1";\nimport { fakeJoin } from "jsr:@std/fake";`);
    assert.deepEqual(names(types, "fakeValue."), ["alpha", "beta"]);
    assert.deepEqual(names(types, "fakeJ"), ["fakeJoin"]);
    // Not installed: no types, and nothing was installed.
    types.addCell(`import { other } from "npm:not-installed@2";`);
    assert.deepEqual(names(types, "other."), []);
    // Deno targets resolve npm: themselves; the kernel's cache isn't theirs.
    const deno = service({ npmCache: null });
    deno.addCell(`import { fakeValue } from "npm:fake-pkg@1";`);
    assert.deepEqual(names(deno, "fakeValue."), []);
  } finally {
    if (saved === undefined) delete process.env.CDPK_CACHE_DIR;
    else process.env.CDPK_CACHE_DIR = saved;
  }
});

test("relative imports resolve from the notebook's directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "cdpk-nb-"));
  writeFileSync(join(dir, "helper.ts"), "export const helper = { gamma: 1 };\n");
  const types = service({ notebookDir: dir });
  types.addCell(`import { helper } from "./helper.ts";`);
  assert.deepEqual(names(types, "helper."), ["gamma"]);
});

test("quick info gives the declared type, signature and JSDoc (#274)", () => {
  const types = service();
  types.addCell("/**\n * Adds two numbers.\n * @param a the first\n */\nfunction add(a: number, b: number) { return a + b; }");
  const expected = "function add(a: number, b: number): number\nAdds two numbers.\n@param a the first";
  assert.equal(types.quickInfo("add", 3), expected);
  assert.equal(types.quickInfo("add(", 4), expected, "right after the call's parenthesis");
  assert.equal(types.quickInfo("add", 1), expected, "inside the name");
  // An undeclared name: the runtime may still know it.
  assert.equal(types.quickInfo("notDeclared", 11), null);
  types.addCell("let pending: Promise<string[]> | undefined;");
  assert.equal(types.quickInfo("pending", 7), "let pending: Promise<string[]> | undefined");
  assert.equal(types.quickInfo("  ", 1), null);
});

test("quick info reaches members of expressions the runtime can't evaluate", () => {
  const types = service();
  const code = "[1, 2].map((n) => n.toFixed";
  assert.match(types.quickInfo(code, code.length) ?? "", /^\(method\) Number\.toFixed\(fractionDigits\?: number\): string/);
});

test("quick info leaves an unresolved import to the runtime", () => {
  const types = service({ notebookDir: mkdtempSync(join(tmpdir(), "cdpk-nb-")) });
  types.addCell(`import { missing } from "npm:not-installed@1";`);
  assert.equal(types.quickInfo("missing", 7), null);
});

// --- Diagnostics (#514) -------------------------------------------------------

function errors(types: NotebookTypes, code: string) {
  return types.diagnostics(code, 10_000)?.map(({ start, end, code: id }) => ({ start, end, text: code.slice(start, end), code: id }));
}

test("diagnostics: a type error in the cell, at its range in the cell", () => {
  const types = service();
  types.addCell("let earlier = 1;");
  assert.deepEqual(types.diagnostics("const n: string = 1", 10_000), [
    { start: 6, end: 7, severity: "error", code: 2322, message: "Type 'number' is not assignable to type 'string'." },
  ]);
  assert.deepEqual(errors(types, "let y = ;"), [{ start: 8, end: 9, text: ";", code: 1109 }]);
  // Only the cell's own errors, not the history's.
  types.addCell("const broken: string = 2;");
  assert.deepEqual(errors(types, "earlier + 1"), []);
});

test("diagnostics: a name an earlier cell declared may be declared again", () => {
  const types = service();
  // Partly redeclared, so the history keeps these statements.
  types.addCell("let a = 1, b = 2;\nfunction f() {}\nenum E { A }\nimport { join } from 'node:path';");
  assert.deepEqual(errors(types, "let a = 'x';"), []);
  assert.deepEqual(errors(types, "function f() { return 1; }"), []);
  assert.deepEqual(errors(types, "enum E { B }"), []);
  assert.deepEqual(errors(types, "const join = 1;"), []);
  // Twice in one cell is still an error, as it is at runtime.
  assert.deepEqual(errors(types, "let q = 1; let q = 2;")?.map((e) => e.code), [2451, 2451]);
  // Even for a name an earlier cell declared.
  assert.deepEqual(errors(types, "let a = 1; let a = 2;")?.map((e) => e.code), [2451, 2451]);
});

test("diagnostics: top-level await, and a cell without imports or exports, aren't errors", () => {
  const types = service();
  assert.deepEqual(errors(types, "const x = await Promise.resolve(1);\nx.toFixed();"), []);
  // In a script, these would clash with lib.dom's globals.
  assert.deepEqual(errors(types, "const name = 'x'; const status = 2;"), []);
});

test("diagnostics: an import that hasn't run isn't an error; a missing relative file is", () => {
  const notebookDir = mkdtempSync(join(tmpdir(), "cdpk-diag-"));
  const types = service({ notebookDir });
  types.addCell("const before = 1;");
  assert.deepEqual(errors(types, "import isOdd from 'npm:is-odd@3';\nisOdd(1);"), []);
  assert.deepEqual(errors(types, "import lodash from 'lodash';\nlodash.map;"), []);
  assert.deepEqual(errors(types, "import x from './missing.ts';\nx;"), [{ start: 14, end: 28, text: "'./missing.ts'", code: 2307 }]);
});

test("diagnostics: a global the target has without types isn't an error", () => {
  const types = new NotebookTypes(ts, { notebookDir: repo, npmCache: "npm", types: [], typeFiles: [], globals: kernelGlobals(display, ["Deno"]) });
  assert.deepEqual(errors(types, "Deno.env.get('HOME');"), []);
  assert.deepEqual(errors(service(), "Deno.env.get('HOME');")?.map((e) => e.code), [2304]);
});

test("diagnostics: a check over its budget gives null", () => {
  const types = service();
  const big = Array.from({ length: 3000 }, (_, i) => `const v${i}: number = [1, 2, 3].map((x) => x * ${i}).reduce((a, b) => a + b, 0);`).join("\n");
  assert.equal(types.diagnostics(big, 1), null);
  // The next check isn't cut short.
  assert.deepEqual(errors(types, "const n: string = 1")?.map((e) => e.code), [2322]);
});
