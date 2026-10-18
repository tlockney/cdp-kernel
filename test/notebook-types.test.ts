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

function service(options: { notebookDir?: string; npmCache?: boolean; types?: string[] } = {}) {
  return new NotebookTypes(ts, {
    notebookDir: options.notebookDir ?? repo,
    npmCache: options.npmCache ?? true,
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
    const deno = service({ npmCache: false });
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
