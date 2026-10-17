// The type strippers a kernel can pick (#234): what a cell does must not
// depend on which one ran, so each case runs under both. Cells run as
// transformCellForEval produces them, in a vm context as the Bun target
// runs them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import {
  CellSyntaxError,
  type CellTransformOptions,
  loadTypeStripper,
  transformCell,
  transformCellForEval,
  transformCellWithLines,
  type TypeStripperName,
} from "../src/transform.ts";

const STRIPPERS: TypeStripperName[] = ["esbuild", "sucrase"];
for (const name of STRIPPERS) await loadTypeStripper(name);

type Element = { type: unknown; props: Record<string, unknown> | null; children: unknown[] };

/** A notebook session with a JSX runtime that builds plain objects. */
function session(typeStrip: TypeStripperName, options: CellTransformOptions = {}) {
  const h = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({ type, props, children });
  const jsx = (type: unknown, { children, ...props }: Record<string, unknown>): Element => ({
    type,
    props,
    children: children === undefined ? [] : [children].flat(),
  });
  const Fragment = "Fragment";
  const modules: Record<string, unknown> = {
    "my-jsx/jsx-runtime": { jsx, jsxs: jsx, Fragment },
    "my-jsx/jsx-dev-runtime": { jsxDEV: jsx, Fragment },
    m: { value: "V" },
  };
  const imports: string[] = [];
  const context = createContext({
    React: { createElement: h, Fragment },
    h,
    Fragment,
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
    async cell(code: string): Promise<unknown> {
      const box = (await runInContext(transformCellForEval(code, { ...options, typeStrip }), context)) as unknown[] | undefined;
      return box?.[0] === undefined ? undefined : JSON.parse(JSON.stringify(box[0]));
    },
  };
}

const div = { type: "div", props: { className: "a" }, children: ["hi"] };

for (const name of STRIPPERS) {
  test(`${name}: types are erased`, async () => {
    const s = session(name);
    await s.cell("interface P { x: number }\ntype T = string;\nfunction f(a: string): number { return a.length; }\nconst p: P = { x: f('abc') };");
    assert.equal(await s.cell("p.x satisfies number"), 3);
  });

  test(`${name}: import type goes, other imports stay`, async () => {
    const s = session(name);
    await s.cell('import type { T } from "types";\nimport { type U, value } from "m";\nimport "m";');
    assert.equal(await s.cell("value"), "V");
    assert.deepEqual(s.imports, ["m", "m"]);
  });

  test(`${name}: enums are runtime code`, async () => {
    const s = session(name);
    await s.cell("enum Color { Red, Green }\nconst enum Size { S = 's' }");
    assert.deepEqual(await s.cell("[Color.Green, Color[0], Size.S]"), [1, "Red", "s"]);
  });

  test(`${name}: parameter properties are assigned`, async () => {
    const s = session(name);
    await s.cell("class P { constructor(public x: number, private y = 2) {} sum() { return this.x + this.y; } }");
    assert.equal(await s.cell("new P(1).sum()"), 3);
  });

  test(`${name}: angle-bracket assertions fall back to TS`, async () => {
    const s = session(name);
    assert.equal(await s.cell("const v: unknown = 'x';\n<string>v"), "x");
  });

  test(`${name}: JSX defaults to React.createElement`, async () => {
    assert.deepEqual(await session(name).cell("<div className='a'>hi</div>"), div);
  });

  test(`${name}: classic JSX takes the project's factories`, async () => {
    const s = session(name, { jsx: { mode: "classic", factory: "h", fragment: "Fragment" } });
    assert.deepEqual(await s.cell("<><b>hi</b></>"), {
      type: "Fragment",
      props: null,
      children: [{ type: "b", props: null, children: ["hi"] }],
    });
  });

  for (const development of [false, true]) {
    test(`${name}: the automatic JSX runtime${development ? " (development)" : ""} is imported`, async () => {
      const s = session(name, { jsx: { mode: "automatic", importSource: "my-jsx", development } });
      assert.deepEqual(await s.cell("<div className='a'>hi</div>"), div);
      assert.deepEqual(await s.cell("<div className='a'>hi</div>"), div, "and again in a later cell");
      assert.deepEqual(s.imports, Array(2).fill(`my-jsx/${development ? "jsx-dev-runtime" : "jsx-runtime"}`));
    });
  }

  test(`${name}: top-level await and syntax errors`, async () => {
    assert.equal(await session(name).cell("await Promise.resolve(1)"), 1);
    for (const src of ["const = ;", "let x = (", "let x: = 1"]) {
      assert.throws(() => transformCell(src, { typeStrip: name }), (err: unknown) => {
        assert.ok(err instanceof CellSyntaxError, src);
        assert.doesNotMatch(err.message, /^(Transform failed|Error transforming)/);
        return true;
      }, src);
    }
  });

  test(`${name}: statements map to their lines`, () => {
    const cell = "interface P {\n  x: number;\n}\n\nconst a: number = 1;\ntype T = string;\nconst b = a + 1;";
    const { script, lines } = transformCellWithLines(cell, { typeStrip: name });
    const at = (needle: string) => script.split("\n").findIndex((l) => l.includes(needle));
    assert.equal(lines.toGenerated(4), at("a = 1"));
    assert.equal(lines.toGenerated(6), at("b = a + 1"));
    assert.equal(lines.toOriginal(at("b = a + 1")), 6);
  });
}

test("sucrase rejects decorators and accessor fields with a clear error", () => {
  for (const cell of ["function d(c: any) {}\n@d class A {}", "class A { @d m() {} }", "class A { accessor x = 1; }"]) {
    for (const experimentalDecorators of [false, true]) {
      assert.throws(() => transformCell(cell, { typeStrip: "sucrase", experimentalDecorators }), (err: unknown) =>
        err instanceof CellSyntaxError && /(decorators|accessor fields) are not supported with the sucrase type stripper/.test(err.message), cell);
    }
  }
});

test("sucrase allows @ and accessor where they aren't syntax", () => {
  assert.doesNotThrow(() => transformCell("const e = 'a@b.c'; // @ts-ignore\nlet accessor = 1; accessor++;", { typeStrip: "sucrase" }));
});

test("sucrase rejects namespaces, which it would drop, but not declare namespace", () => {
  for (const cell of ["namespace N { export const a = 1; }", "export namespace N.M { export const a = 1; }", "module N { }"]) {
    assert.throws(() => transformCell(cell, { typeStrip: "sucrase" }), /namespaces are not supported with the sucrase type stripper/, cell);
  }
  assert.doesNotThrow(() => transformCell("declare namespace N { const a: number }\ndeclare module 'm' { }", { typeStrip: "sucrase" }));
});

test("a custom type stripper is called with the cell's options", () => {
  const seen: unknown[] = [];
  const out = transformCell("1 + 1", {
    jsx: { mode: "classic" },
    typeStrip: (code, options, sourcemap) => {
      seen.push([code, options.jsx, sourcemap]);
      return { code: "2", mappings: "" };
    },
  });
  assert.match(out, /\n2\n/);
  assert.deepEqual(seen, [["1 + 1", { mode: "classic" }, false]]);
});
