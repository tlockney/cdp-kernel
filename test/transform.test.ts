import { test } from "node:test";
import assert from "node:assert/strict";
import { CellSyntaxError, objectLiteralCandidate, rewriteModuleSyntax, transformCell } from "../src/transform.ts";

const PRELUDE = "'use strict'; await __cdpk.tick();\n";

interface ImportCall {
  specifier: string;
  options: unknown;
}

// Builds an async function from rewritten code, with a fake __cdpk whose
// import() resolves from `modules`, and runs it. `tail` is appended to the
// code (e.g. a return statement reading the bindings).
async function run(code: string, modules: Record<string, unknown>, tail = ""): Promise<{
  result: unknown;
  calls: ImportCall[];
}> {
  const calls: ImportCall[] = [];
  const shim = {
    import: (specifier: string, options?: unknown) => {
      calls.push({ specifier, options });
      return Promise.resolve(modules[specifier]);
    },
    meta: { url: "file:///cell" },
    tick: () => Promise.resolve(),
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (shim: unknown) => Promise<unknown>;
  const fn = new AsyncFunction("__cdpk", code + "\n" + tail);
  return { result: await fn(shim), calls };
}

function body(cell: string): string {
  const out = transformCell(cell);
  assert.ok(out.startsWith(PRELUDE));
  return out.slice(PRELUDE.length);
}

test("transformCell prepends the prelude", () => {
  assert.equal(transformCell("1").startsWith(PRELUDE), true);
});

test("default, named, aliased and namespace imports bind correctly", async () => {
  const mod = { default: "D", a: "A", b: "B" };
  const code = rewriteModuleSyntax(
    'import d, { a, b as c } from "m"; import * as ns from "m";',
  );
  const { result, calls } = await run(code, { m: mod }, "return [d, a, c, ns];");
  assert.deepEqual(result, ["D", "A", "B", mod]);
  assert.deepEqual(calls.map((c) => c.specifier), ["m", "m"]);
});

test("string-literal import names are supported", async () => {
  const code = rewriteModuleSyntax('import { "a-b" as ab } from "m";');
  const { result } = await run(code, { m: { "a-b": 5 } }, "return ab;");
  assert.equal(result, 5);
});

test("side-effect import only loads the module", async () => {
  const code = rewriteModuleSyntax('import "side";');
  assert.equal(code.includes("__cdpk.import("), true);
  const { calls } = await run(code, { side: {} });
  assert.deepEqual(calls.map((c) => c.specifier), ["side"]);
});

test("import attributes are passed through", async () => {
  const code = rewriteModuleSyntax('import data from "./x.json" with { type: "json" };');
  const { result, calls } = await run(code, { "./x.json": { default: { k: 1 } } }, "return data;");
  assert.deepEqual(result, { k: 1 });
  assert.deepEqual(calls[0].options, { with: { type: "json" } });
});

test("dynamic import() is rewritten to __cdpk.import(", async () => {
  const code = rewriteModuleSyntax('const m = await import("dyn"); const n = import("dyn2");');
  assert.match(code, /__cdpk\.import\("dyn"\)/);
  assert.doesNotMatch(code, /[^.]\bimport\(/);
  const { result } = await run(code, { dyn: "X", dyn2: "Y" }, "return [m, await n];");
  assert.deepEqual(result, ["X", "Y"]);
});

test("import.meta becomes __cdpk.meta", async () => {
  const code = rewriteModuleSyntax("const u = import.meta.url;");
  assert.match(code, /__cdpk\.meta\.url/);
  const { result } = await run(code, {}, "return u;");
  assert.equal(result, "file:///cell");
});

test("export declarations are stripped to plain declarations", () => {
  assert.equal(rewriteModuleSyntax("export const a = 1;"), "const a = 1;");
  assert.equal(rewriteModuleSyntax("export function f() {}"), "function f() {}");
  assert.equal(rewriteModuleSyntax("export class K {}"), "class K {}");
});

test("export default keeps just the expression", () => {
  assert.equal(rewriteModuleSyntax("export default 1 + 2;"), "1 + 2;");
});

test("export { a } is removed", () => {
  const out = rewriteModuleSyntax("const a = 1; export { a };");
  assert.equal(out, "const a = 1; ");
});

test("re-exports throw CellSyntaxError", () => {
  for (const src of ['export * from "m";', 'export { a } from "m";', 'export * as ns from "m";']) {
    assert.throws(() => rewriteModuleSyntax(src), (err: unknown) => {
      assert.ok(err instanceof CellSyntaxError, src);
      assert.equal(err.name, "SyntaxError");
      assert.match(err.message, /re-exports/);
      return true;
    }, src);
  }
});

test("TypeScript-only syntax is erased", () => {
  const out = body("interface Foo { a: number }\ntype T = string;\nconst x: number = 1;\nfunction f(a: string): void {}");
  assert.doesNotMatch(out, /interface|type T|: number|: string|: void/);
  assert.match(out, /const x = 1/);
  assert.match(out, /function f\(a\)/);
});

test("enums are kept as runtime code", async () => {
  const out = body("enum Color { Red, Green }\nColor.Green;");
  const { result } = await run(out.replace(/Color\.Green;\s*$/, ""), {}, "return Color.Green;");
  assert.equal(result, 1);
});

test("JSX becomes React.createElement", () => {
  const out = body("const el = <div className='a'>hi</div>;");
  assert.match(out, /React\.createElement\("div"/);
});

test("angle-bracket assertions fall back to the TS loader", () => {
  const out = body("const s = <string>someValue;");
  assert.doesNotMatch(out, /<string>/);
  assert.match(out, /const s = someValue/);
});

test("syntax errors throw CellSyntaxError named SyntaxError", () => {
  for (const src of ["const = ;", "let x = (", "foo bar baz"]) {
    assert.throws(() => transformCell(src), (err: unknown) => {
      assert.ok(err instanceof CellSyntaxError, src);
      assert.equal(err.name, "SyntaxError");
      assert.doesNotMatch(err.message, /^Transform failed/);
      return true;
    }, src);
  }
});

test("rewriteModuleSyntax rejects invalid plain JavaScript", () => {
  assert.throws(() => rewriteModuleSyntax("let = ;"), CellSyntaxError);
});

test("top-level await is accepted", () => {
  assert.doesNotThrow(() => transformCell("const v = await Promise.resolve(1);"));
});

test("objectLiteralCandidate wraps brace-led cells without a trailing semicolon", () => {
  assert.equal(objectLiteralCandidate('{ "a": 1 }'), '({ "a": 1 })');
  assert.equal(objectLiteralCandidate('  { a: 1 }\n'), '(  { a: 1 }\n)');
  assert.equal(objectLiteralCandidate("{ a: 1 };"), null);
  assert.equal(objectLiteralCandidate("{ a: 1 }; \n"), null);
  assert.equal(objectLiteralCandidate("1 + 1"), null);
  assert.equal(objectLiteralCandidate("foo({})"), null);
});

test("transformCell applies an automatic JSX runtime from the project config", () => {
  const out = transformCell("<b>hi</b>", { jsx: { mode: "automatic", importSource: "my-jsx", development: false } });
  // esbuild's runtime import is rewritten like any other static import.
  assert.match(out, /await __cdpk\.import\("my-jsx\/jsx-runtime"\)/);
  assert.doesNotMatch(out, /React\.createElement/);
});

test("transformCell applies classic JSX factories from the project config", () => {
  const out = transformCell("<><b>hi</b></>", { jsx: { mode: "classic", factory: "h", fragment: "Fragment" } });
  assert.match(out, /h\(Fragment, null, \/\* @__PURE__ \*\/ h\("b", null, "hi"\)\)/);
});

test("transformCell keeps the classic React default without project options", () => {
  assert.match(transformCell("<b>hi</b>"), /React\.createElement\("b"/);
});

test("standard decorators and accessor fields are lowered (#142)", async () => {
  const cell = [
    "function tag(cls: any, ctx: ClassDecoratorContext) { cls.prototype.tag = ctx.name; }",
    "function twice(_: unknown, ctx: ClassAccessorDecoratorContext) { return { init: (v: number) => v * 2 }; }",
    "@tag class A { @twice accessor x = 1; }",
  ].join("\n");
  const out = body(cell);
  assert.doesNotMatch(out, /^\s*@/m);
  const { result } = await run(out.replace(/\n;let __cdpk_settled = await __cdpk\.tick\(\);$/, ""), {}, "return [new A().x, new A().tag];");
  assert.deepEqual(result, [2, "A"]);
});

test("transformCell honours experimentalDecorators from the project config", () => {
  const cell = "function log(t: unknown) {}\nclass A { @log m() {} }";
  // TS legacy decorators compile to a __decorateClass helper call.
  assert.match(transformCell(cell, { experimentalDecorators: true }), /__decorateClass/);
});
