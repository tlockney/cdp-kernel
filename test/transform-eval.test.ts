// transformCellForEval: cells for a target that evaluates them in-process
// (Bun, #7), without the inspector's replMode. Each produced script is run
// as global code in a fresh vm context, as the Bun target's indirect eval
// runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { CellSyntaxError, transformCellForEval } from "../src/transform.ts";

/** A notebook session: runs cells in order, sharing one global scope. */
function session(modules: Record<string, unknown> = {}) {
  const imports: string[] = [];
  const context = createContext({
    __cdpk: {
      import: (specifier: string) => {
        imports.push(specifier);
        return Promise.resolve(modules[specifier]);
      },
      meta: { url: "file:///cell" },
    },
  });
  return {
    imports,
    context,
    /** The cell's boxed result: [value] for a trailing expression, else undefined. */
    async cell(code: string): Promise<unknown[] | undefined> {
      const box: unknown = await runInContext(transformCellForEval(code), context);
      if (box === undefined) return undefined;
      assert.ok(Array.isArray(box), "result is boxed in an array");
      // Values from the vm context have its prototypes; copy plain data
      // across so deepEqual compares structure. Others pass through.
      return Array.from(box, (v: unknown) => (typeof v === "object" && v !== null && !(v instanceof runInContext("Promise", context)) ? structuredClone(v) : v));
    },
  };
}

test("top-level const and let persist across cells", async () => {
  const s = session();
  assert.equal(await s.cell("const a = 1; let b = 2;"), undefined);
  assert.deepEqual(await s.cell("a + b"), [3]);
});

test("a const can be redeclared by a later cell", async () => {
  const s = session();
  await s.cell("const dup = 1");
  assert.deepEqual(await s.cell("const dup = 2; dup"), [2]);
});

test("destructuring declarations bind every name", async () => {
  const s = session();
  await s.cell("const { x, y: [z = 9, w], ...rest } = { x: 1, y: [undefined, 2], v: 3 }");
  assert.deepEqual(await s.cell("[x, z, w, rest.v]"), [[1, 9, 2, 3]]);
});

test("let without an initializer resets the name; var without one keeps it", async () => {
  const s = session();
  await s.cell("let l = 1; var v = 1;");
  await s.cell("let l; var v;");
  assert.deepEqual(await s.cell("[l, v]"), [[undefined, 1]]);
});

test("functions are hoisted within the cell and visible to later cells", async () => {
  const s = session();
  assert.deepEqual(await s.cell("const early = f();\nfunction f() { return 7 }\nearly"), [7]);
  assert.deepEqual(await s.cell("f()"), [7]);
  await s.cell("async function g() { return 8 }\nfunction* h() { yield 9 }");
  assert.deepEqual(await s.cell("[await g(), [...h()][0]]"), [[8, 9]]);
});

test("classes are visible to later cells", async () => {
  const s = session();
  await s.cell("class A { static k = 1; get self() { return A } }");
  assert.deepEqual(await s.cell("[A.k, new A().self === A]"), [[1, true]]);
});

test("closures share the global binding, not a copy", async () => {
  const s = session();
  await s.cell("let n = 0;\nfunction inc() { n++ }");
  assert.deepEqual(await s.cell("inc(); inc(); n"), [2]);
});

test("top-level await works and its results persist", async () => {
  const s = session();
  await s.cell("const v = await Promise.resolve(5);");
  assert.deepEqual(await s.cell("v"), [5]);
});

test("a trailing promise is returned as a value, not awaited", async () => {
  const s = session();
  const box = await s.cell("Promise.resolve(1)");
  assert.ok(box?.[0] instanceof runInContext("Promise", s.context));
});

test("only a trailing expression statement produces a result", async () => {
  const s = session();
  assert.equal(await s.cell("const q = 1"), undefined);
  assert.equal(await s.cell("if (true) { 5 }"), undefined);
  assert.deepEqual(await s.cell("null"), [null]);
});

test("block-scoped and function-local declarations stay local", async () => {
  const s = session();
  await s.cell("for (let i = 0; i < 2; i++) {}\n{ const inner = 1 }\nfunction local() { var inFn = 1 }\n(() => { var inArrow = 1 })()");
  assert.deepEqual(await s.cell("[typeof i, typeof inner, typeof inFn, typeof inArrow]"), [[
    "undefined",
    "undefined",
    "undefined",
    "undefined",
  ]]);
});

test("var inside top-level blocks and loop heads is global, as in a script", async () => {
  const s = session();
  await s.cell(
    "if (true) { var inIf = 1 }\nfor (var k = 0; k < 3; k++) {}\nfor (var key in { p: 1 }) {}\n" +
      "for (var [e] of [[4]]) {}\ntry { var inTry = 5 } finally {}\nlabel: { var inLabel = 6 }",
  );
  assert.deepEqual(await s.cell("[inIf, k, key, e, inTry, inLabel]"), [[1, 3, "p", 4, 5, 6]]);
});

test("cell code is strict", async () => {
  const s = session();
  await assert.rejects(s.cell("undeclaredName = 1"), (err: unknown) => {
    assert.equal((err as Error).name, "ReferenceError");
    return true;
  });
});

test("imports go through __cdpk.import and bind globally", async () => {
  const s = session({ m: { default: "D", j: "J" } });
  await s.cell('import d, { j } from "m";');
  assert.deepEqual(await s.cell("[d, j]"), [["D", "J"]]);
  assert.deepEqual(s.imports, ["m"]);
});

test("TypeScript enums and annotations survive", async () => {
  const s = session();
  await s.cell("enum Color { Red, Green }\nconst c: Color = Color.Green;");
  assert.deepEqual(await s.cell("c"), [1]);
});

test("syntax errors throw CellSyntaxError", () => {
  assert.throws(() => transformCellForEval("const = ;"), CellSyntaxError);
});

test("standard decorators work in the eval path (#142)", async () => {
  const s = session();
  await s.cell([
    "function tag(cls: any, ctx: ClassDecoratorContext) { cls.prototype.tag = ctx.name; }",
    "function twice(_: unknown, ctx: ClassAccessorDecoratorContext) { return { init: (v: number) => v * 2 }; }",
    "@tag class A { @twice accessor x = 1; }",
  ].join("\n"));
  assert.deepEqual(await s.cell("[new A().x, new A().tag]"), [[2, "A"]]);
});
