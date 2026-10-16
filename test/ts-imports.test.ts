// TypeScript files a cell imports on Node (#73): Node strips types where it
// can, and esbuild compiles what Node's stripping rejects.
import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileTypeScript, loadTypeScript } from "../runtime/node-hooks.mjs";
import { esbuildBinary, Target, type TargetEvents } from "../src/target.ts";

const events: TargetEvents = { stream: () => {}, message: () => {}, exit: () => {} };

const NEEDS_CODEGEN = `
export enum Color { Red, Green }
export namespace Shapes { export const sides = 4; }
export class Point { constructor(public x: number, private y: number) {} sum() { return this.x + this.y; } }
`;

function notebookDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "cdpk-ts-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

async function launch(t: TestContext, cwd: string) {
  const target = await Target.launch("node", events, { cwd });
  t.after(() => target.kill());
  return async (code: string) => {
    const res = await target.evaluate(target.transform(code, {}));
    assert.equal(res.exceptionDetails, undefined, JSON.stringify(res.exceptionDetails));
    return res.result.value;
  };
}

test("the host finds its esbuild binary", () => {
  assert.notEqual(esbuildBinary(), null);
  assert.equal(esbuildBinary(() => { throw new Error("no esbuild"); }), process.env.ESBUILD_BINARY_PATH ?? null);
});

test("imported .ts files may use enum, value namespaces and parameter properties", async (t) => {
  const cwd = notebookDir({
    "plain.ts": NEEDS_CODEGEN,
    "esm/package.json": '{ "type": "module" }',
    "esm/lib.ts": NEEDS_CODEGEN,
    "lib.mts": NEEDS_CODEGEN,
    "lib.cts": "enum Size { S = 1 }\nmodule.exports = { size: Size.S as number };\n",
  });
  const run = await launch(t, cwd);
  // No package.json "type": Node rejects the file while detecting its format.
  await run(`import { Color, Shapes, Point } from "./plain.ts";`);
  assert.equal(await run(`JSON.stringify([Color.Green, Shapes.sides, new Point(1, 2).sum()])`), "[1,4,3]");
  // A declared format: Node rejects it after loading.
  assert.equal(await run(`(await import("./esm/lib.ts")).Color.Red`), 0);
  assert.equal(await run(`(await import("./lib.mts")).Shapes.sides`), 4);
  assert.equal(await run(`(await import("./lib.cts")).default.size`), 1);
});

test("imported .tsx and .jsx files compile their JSX as cells do", async (t) => {
  const createElement = "const React = { createElement: (t, _p, ...c) => [t, ...c], Fragment: 'F' };\n";
  const cwd = notebookDir({
    "view.tsx": `${createElement}export const el = <b>{"hi" as string}</b>;\nexport const frag = <>x</>;\n`,
    "view.jsx": `${createElement}export const el = <i>hey</i>;\n`,
    "pragma.tsx": "/** @jsx h */\nconst h = (t: string) => t.toUpperCase();\nexport const el = <p />;\n",
  });
  const run = await launch(t, cwd);
  await run(`import { el, frag } from "./view.tsx";`);
  assert.equal(await run(`JSON.stringify([el, frag])`), '[["b","hi"],["F","x"]]');
  assert.equal(await run(`JSON.stringify((await import("./view.jsx")).el)`), '["i","hey"]');
  assert.equal(await run(`(await import("./pragma.tsx")).el`), "P");
});

test("a query or fragment on an imported .ts or .tsx URL doesn't skip the compile (#145)", async (t) => {
  const cwd = notebookDir({
    "plain.ts": NEEDS_CODEGEN,
    "view.tsx": "const React = { createElement: (t: string) => t };\nexport const el = <b />;\n",
  });
  const run = await launch(t, cwd);
  assert.equal(await run(`(await import("./plain.ts?v=2")).Color.Green`), 1);
  assert.equal(await run(`(await import("./plain.ts#x")).Shapes.sides`), 4);
  assert.equal(await run(`(await import("./view.tsx?v=2")).el`), "b");
});

test("a .ts file Node can strip keeps its line numbers", async (t) => {
  const cwd = notebookDir({
    "strip.ts": "type T = {\n  a: number;\n};\n\nexport function where(): string {\n  return new Error().stack!.split(\"\\n\")[1];\n}\n",
  });
  const run = await launch(t, cwd);
  assert.match(String(await run(`(await import("./strip.ts")).where()`)), /strip\.ts:6:/);
});

test("without an esbuild binary, Node's own result stands", () => {
  const next = () => ({ format: "module-typescript", source: "enum E { A }" });
  assert.deepEqual(loadTypeScript("file:///x.ts", {}, next, undefined), next());
  // Not TypeScript: untouched even with a binary.
  const js = () => ({ format: "module", source: "export {}" });
  assert.deepEqual(loadTypeScript("file:///x.js", {}, js, "/esbuild"), js());
});

test("compileTypeScript passes the source on stdin and reports esbuild's error", () => {
  const calls: { input: string; args: string[] }[] = [];
  const ok = compileTypeScript("enum E { A }", "/n/x.ts", "/esbuild", (_cmd, args, options) => {
    calls.push({ args, input: (options as { input: string }).input });
    return { status: 0, stdout: "compiled", stderr: "" };
  });
  assert.equal(ok, "compiled");
  assert.equal(calls[0].input, "enum E { A }");
  assert.ok(calls[0].args.includes("--sourcefile=/n/x.ts"));
  assert.throws(
    () => compileTypeScript("x", "/n/x.ts", "/esbuild", () => ({ status: 1, stdout: "", stderr: "✘ [ERROR] Unexpected\n" })),
    { name: "SyntaxError", message: "/n/x.ts: ✘ [ERROR] Unexpected" },
  );
});

test("a cell ending in a side-effect or type-only import has no result (#139)", async (t) => {
  const cwd = notebookDir({ "side.ts": "export type X = number;\n(globalThis as any).sideRan = true;\n" });
  const target = await Target.launch("node", events, { cwd });
  t.after(() => target.kill());
  for (const code of ['import "./side.ts"', 'import { type X } from "./side.ts"']) {
    const res = await target.evaluate(target.transform(code, {}));
    assert.equal(res.exceptionDetails, undefined, JSON.stringify(res.exceptionDetails));
    assert.equal(res.result.type, "undefined", code);
  }
  const res = await target.evaluate(target.transform("sideRan", {}));
  assert.equal(res.result.value, true);
});
