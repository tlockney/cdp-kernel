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

// --- Signature, definition and rename (#522) ----------------------------------

test("signature: the call's signature with the active parameter", () => {
  const types = service();
  types.addCell("/** Adds two numbers. */\nfunction add(a: number, b: number): number { return a + b; }");
  const first = types.signature("add(1", 5, 10_000);
  assert.equal(first?.label, "add(a: number, b: number): number");
  assert.equal(first?.documentation, "Adds two numbers.");
  assert.deepEqual(first?.parameters.map((p) => p.label), ["a: number", "b: number"]);
  assert.equal(first?.activeParameter, 0);
  assert.equal(types.signature("add(1, ", 7, 10_000)?.activeParameter, 1);
  // Outside a call there is nothing to show.
  assert.equal(types.signature("add", 3, 10_000), null);
  // A rest parameter stays active for every argument after it.
  types.addCell("function all(...xs: number[]) {}");
  assert.equal(types.signature("all(1, 2, 3, ", 13, 10_000)?.activeParameter, 0);
});

test("signature: parameter documentation, and the overload that fits", () => {
  const types = service();
  types.addCell("/**\n * Greets.\n * @param who the name\n */\nfunction greet(who: string): void {}\nfunction pick(a: string): string;\nfunction pick(a: number, b: number): number;\nfunction pick(a: any, b?: any): any { return a; }");
  assert.equal(types.signature("greet(", 6, 10_000)?.parameters[0].documentation, "the name");
  assert.equal(types.signature("pick(1, ", 8, 10_000)?.label, "pick(a: number, b: number): number");
});

test("signature: a check over its budget gives null", () => {
  const types = service();
  const big = Array.from({ length: 3000 }, (_, i) => `const v${i}: number = [1, 2, 3].map((x) => x * ${i}).reduce((a, b) => a + b, 0);`).join("\n");
  types.addCell(big);
  assert.equal(types.signature("Math.max(", 9, 1), null);
});

/** The cell, start and text of each location. */
function places(cells: string[], spans: { cell: number; start: number; end: number }[] | null) {
  return spans?.map((s) => ({ cell: s.cell, start: s.start, text: cells[s.cell].slice(s.start, s.end) }));
}

test("definition: to an earlier cell, and to the same cell", () => {
  const types = service();
  const cells = ["const base = 1;", "function area(w: number) { return w * base; }", "area(base);"];
  assert.deepEqual(places(cells, types.definition(cells, 2, 1, 10_000)), [{ cell: 1, start: 9, text: "area" }]);
  assert.deepEqual(places(cells, types.definition(cells, 2, 6, 10_000)), [{ cell: 0, start: 6, text: "base" }]);
  // The same cell, from a use inside a function body.
  assert.deepEqual(places(cells, types.definition(cells, 1, 40, 10_000)), [{ cell: 0, start: 6, text: "base" }]);
  const same = ["const n = 1;\nn + 1"];
  assert.deepEqual(places(same, types.definition(same, 0, 14, 10_000)), [{ cell: 0, start: 6, text: "n" }]);
});

test("definition: only inside the cells; a name from a package or an unknown name gives none", () => {
  const types = service({ types: ["node"] });
  const cells = ["import { join } from 'node:path';", "join('a', 'b');\nprocess.cwd();\nnope;\nconst o = { k: 1 };\no.k;"];
  assert.deepEqual(types.definition(cells, 1, 2, 10_000), []);
  assert.deepEqual(types.definition(cells, 1, 18, 10_000), []);
  assert.deepEqual(types.definition(cells, 1, 32, 10_000), []);
  // Where the use is later than the declaration, in a cell that comes later in the notebook.
  const k = cells[1].lastIndexOf("o.k") + 2;
  assert.deepEqual(places(cells, types.definition(cells, 1, k, 10_000)), [{ cell: 1, start: cells[1].indexOf("k: 1"), text: "k" }]);
  // Declared only in a later cell: not there yet.
  const later = ["x;", "const x = 1;"];
  assert.deepEqual(types.definition(later, 0, 0, 10_000), []);
});

test("definition: a name declared in several cells has the nearest declaration before the use", () => {
  const types = service();
  const cells = ["const v = 1;", "v;", "const v = 'two';", "v.toUpperCase();", "function v2() {}\nfunction v2() {}"];
  assert.deepEqual(places(cells, types.definition(cells, 1, 0, 10_000)), [{ cell: 0, start: 6, text: "v" }]);
  assert.deepEqual(places(cells, types.definition(cells, 3, 0, 10_000)), [{ cell: 2, start: 6, text: "v" }]);
  // A use in the redeclaring cell's own statement is that cell's.
  const own = ["const w = 1;", "const w = 2;\nw;"];
  assert.deepEqual(places(own, types.definition(own, 1, 14, 10_000)), [{ cell: 1, start: 6, text: "w" }]);
  // Members resolve against the nearest declaration's type.
  const objects = ["const o = { a: 1 };", "const o = { b: 2 };", "o.b;"];
  assert.deepEqual(places(objects, types.definition(objects, 2, 2, 10_000)), [{ cell: 1, start: 12, text: "b" }]);
});

test("definition: uses the frontend's cells, not the cells that ran", () => {
  const types = service();
  types.addCell("const ran = 1;");
  const cells = ["const shown = 1;", "shown;"];
  assert.deepEqual(places(cells, types.definition(cells, 1, 0, 10_000)), [{ cell: 0, start: 6, text: "shown" }]);
  const cellsRan = ["ran;"];
  assert.deepEqual(types.definition(cellsRan, 0, 0, 10_000), []);
});

/** Applies a rename's edits to the cells. */
function renamed(cells: string[], result: ReturnType<NotebookTypes["rename"]>): string[] {
  assert.ok(result !== null && "edits" in result, JSON.stringify(result));
  const out = [...cells];
  for (const e of [...result.edits].sort((a, b) => b.start - a.start)) out[e.cell] = out[e.cell].slice(0, e.start) + e.text + out[e.cell].slice(e.end);
  return out;
}

test("rename: across three cells, from a use or the declaration", () => {
  const types = service();
  const cells = ["const total = 1;", "console.log(total);\nconst bigger = total + 1;", "function f() { return total; }"];
  const expected = ["const sum = 1;", "console.log(sum);\nconst bigger = sum + 1;", "function f() { return sum; }"];
  assert.deepEqual(renamed(cells, types.rename(cells, 1, 14, "sum", 10_000)), expected);
  assert.deepEqual(renamed(cells, types.rename(cells, 0, 7, "sum", 10_000)), expected);
  // Only the name, not another one that contains it.
  const edits = types.rename(cells, 0, 7, "sum", 10_000);
  assert.ok(edits !== null && "edits" in edits);
  assert.deepEqual(edits.edits.map((e) => e.cell), [0, 1, 1, 2]);
});

test("rename: a shorthand property keeps its key, a member of another object is left", () => {
  const types = service();
  const cells = ["const x = 1;", "const o = { x };\nconst p = { x: 2 };\np.x;"];
  assert.deepEqual(renamed(cells, types.rename(cells, 0, 6, "y", 10_000)), ["const y = 1;", "const o = { x: y };\nconst p = { x: 2 };\np.x;"]);
});

test("rename: refused for a package export, the globals, a keyword and a bad name", () => {
  const types = service({ types: ["node"] });
  const cells = ["import { join } from 'node:path';", "join('a');\nprocess.cwd();\nprompt('x');\nMath.max(1);\nif (true) {}\nconst k = 1;"];
  const refused = (cell: number, at: number, name = "renamed") => {
    const r = types.rename(cells, cell, at, name, 10_000);
    assert.ok(r !== null && "error" in r, JSON.stringify(r));
    return r.error;
  };
  assert.match(refused(1, 1), /./);
  assert.match(refused(0, 10), /./);
  refused(1, 12); // process
  refused(1, 24); // the kernel's own prompt
  refused(1, 38); // Math, in TypeScript's library
  refused(1, cells[1].indexOf("if"), "kw"); // a keyword
  assert.match(refused(1, cells[1].indexOf("k = 1"), "class"), /not a valid name/);
  assert.match(refused(1, cells[1].indexOf("k = 1"), "a b"), /not a valid name/);
  // Nothing was written for the refused ones.
  const ok = types.rename(cells, 1, cells[1].indexOf("k = 1"), "kk", 10_000);
  assert.ok(ok !== null && "edits" in ok);
});

test("rename: what another file declares is refused, an imported name is renamed in the notebook only", () => {
  const notebookDir = mkdtempSync(join(tmpdir(), "cdpk-rename-"));
  writeFileSync(join(notebookDir, "lib.ts"), "export const shared = { prop: 1 };\n");
  const types = service({ notebookDir });
  const cells = ["import { shared } from './lib.ts';", "shared.prop;"];
  // A property the other file declares would be renamed there too.
  const refused = types.rename(cells, 1, 9, "other", 10_000);
  assert.ok(refused !== null && "error" in refused && /outside the notebook/.test(refused.error), JSON.stringify(refused));
  assert.deepEqual(types.definition(cells, 1, 9, 10_000), []);
  // The import's local name is the notebook's own: `shared as other` keeps the export's name.
  assert.deepEqual(renamed(cells, types.rename(cells, 1, 0, "other", 10_000)), ["import { shared as other } from './lib.ts';", "other.prop;"]);
});

test("rename: a name declared again in a later cell is two variables; the cursor's is renamed", () => {
  const types = service();
  const cells = ["const v = 1;", "v + 1;", "const v = 'two';", "v.length;", "v;"];
  // From the first variable: its declaration and the use before the redeclaration.
  assert.deepEqual(renamed(cells, types.rename(cells, 1, 0, "one", 10_000)), ["const one = 1;", "one + 1;", "const v = 'two';", "v.length;", "v;"]);
  assert.deepEqual(renamed(cells, types.rename(cells, 0, 6, "one", 10_000)), ["const one = 1;", "one + 1;", "const v = 'two';", "v.length;", "v;"]);
  // From the second: the redeclaration and the uses after it.
  assert.deepEqual(renamed(cells, types.rename(cells, 3, 0, "two", 10_000)), ["const v = 1;", "v + 1;", "const two = 'two';", "two.length;", "two;"]);
  // Declared only in a later cell.
  const later = ["x;", "const x = 1;"];
  const r = types.rename(later, 0, 0, "y", 10_000);
  assert.ok(r !== null && "error" in r && /later cell/.test(r.error), JSON.stringify(r));
});

test("rename: a check over its budget gives null", () => {
  const types = service();
  // Renaming a property needs the type of every object it is read from.
  const heavy = Array.from({ length: 2000 }, (_, i) => `const o${i} = [1, 2, 3].map((x) => ({ k: x * ${i} })).filter(Boolean).reduce((a, b) => ({ k: a.k + b.k }), { k: 0 });`);
  const cells = [...heavy, "o1.k;"];
  assert.equal(types.rename(cells, 2000, 3, "z", 1), null);
  // The next one isn't cut short.
  const result = types.rename(cells, 2000, 3, "z", 30_000);
  assert.ok(result !== null && "edits" in result && result.edits.some((e) => e.cell === 2000), JSON.stringify(result));
});

test("definition and rename: positions in a cell are UTF-16 indices", () => {
  const types = service();
  const cells = ["const s = '😀'; const name = 1;", "name;"];
  const at = cells[0].indexOf("name");
  assert.deepEqual(places(cells, types.definition(cells, 1, 0, 10_000)), [{ cell: 0, start: at, text: "name" }]);
});
