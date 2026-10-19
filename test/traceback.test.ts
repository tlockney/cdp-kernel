// Structured tracebacks (#322).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTraceback, cellName, isLibraryFile, parseFrame, type TracebackFrame } from "../src/traceback.ts";
import { loadTypeStripper, transformCellWithLines } from "../src/transform.ts";

await loadTypeStripper("esbuild");

test("parseFrame reads V8 frames", () => {
  assert.deepEqual(parseFrame("    at add (file:///a/b.ts:3:20)"), { name: "add", file: "file:///a/b.ts", line: 3, column: 20 });
  assert.deepEqual(parseFrame("    at C:\\x\\y.js:1:2"), { name: "", file: "C:\\x\\y.js", line: 1, column: 2 });
  assert.deepEqual(parseFrame("    at async Promise.all (index 0)"), { name: "async Promise.all", file: "index 0", line: null, column: null });
  assert.deepEqual(parseFrame("    at Array.map (<anonymous>)"), { name: "Array.map", file: "<anonymous>", line: null, column: null });
  assert.equal(parseFrame("TypeError: at (x:1:2)"), null, "the message is not a frame");
});

test("parseFrame reads JavaScriptCore and SpiderMonkey frames", () => {
  assert.deepEqual(parseFrame("add@http://h/w.js:3:20"), { name: "add", file: "http://h/w.js", line: 3, column: 20 });
  assert.deepEqual(parseFrame("@cell.ts:2:1"), { name: "", file: "cell.ts", line: 2, column: 1 });
  assert.deepEqual(parseFrame("map@[native code]"), { name: "map", file: "[native code]", line: null, column: null });
  assert.equal(parseFrame("Error: mail me@example.com"), null);
});

test("isLibraryFile: packages, runtimes and the kernel's own files", () => {
  for (const file of ["node:internal/x", "ext:core/01_core.js", "internal:streams/readable", "native", "<anonymous>",
    "/p/node_modules/lodash/x.js", "C:\\p\\node_modules\\x.js", "https://jsr.io/@std/fmt/1.0.0/x.ts", "npm:x"]) {
    assert.equal(isLibraryFile(file), true, file);
  }
  for (const file of ["/home/me/lib.ts", "file:///home/me/lib.ts", "https://example.com/x.js"]) {
    assert.equal(isLibraryFile(file), false, file);
  }
  assert.equal(isLibraryFile("file:///k/runtime/evaluator.mjs", ["file:///k/runtime/"]), true);
});

function cellSources(cells: Record<string, { code: string; executionCount: number | null; cellId?: string }>) {
  return {
    cell(file: string) {
      const cell = cells[file];
      if (cell === undefined) return undefined;
      return { code: cell.code, executionCount: cell.executionCount, cellId: cell.cellId ?? null, lines: transformCellWithLines(cell.code).lines };
    },
  };
}

test("buildTraceback maps cell frames to the lines the user wrote", () => {
  const defining = "type N = number;\ninterface Q { a: N }\nfunction add(a: N, b: N): N {\n  if (b < 0) throw new Error('neg');\n  return a + b;\n}";
  const calling = "const x: N = 1;\n\nadd(x, -1)";
  // Where the stripped script puts them: the type lines are gone, and the
  // prelude adds one line.
  const definingName = cellName(defining);
  const callingName = cellName(calling);
  const stack = `Error: neg\n    at add (${definingName}:3:20)\n    at ${callingName}:3:1`;
  const { lines, payload } = buildTraceback(
    { ename: "Error", evalue: "neg", stack },
    cellSources({ [definingName]: { code: defining, executionCount: 1 }, [callingName]: { code: calling, executionCount: 2, cellId: "c2" } }),
    { executionCount: 2, cellId: "c2" },
  );
  assert.deepEqual(lines, ["Error: neg", "    at add (In[1]:4)", "    at In[2]:3"]);
  const frames = payload.frames as TracebackFrame[];
  assert.deepEqual(frames.map((f) => [f.filename, f.lineno, f.name, f.library]), [["In[1]", 4, "add", false], ["In[2]", 3, "", false]]);
  assert.deepEqual(frames[0].lines, [
    { lineno: 2, source: "interface Q { a: N }" },
    { lineno: 3, source: "function add(a: N, b: N): N {" },
    { lineno: 4, source: "  if (b < 0) throw new Error('neg');", highlight: true },
    { lineno: 5, source: "  return a + b;" },
    { lineno: 6, source: "}" },
  ]);
  assert.equal(frames[0].colno, undefined, "only lines are mapped");
  assert.deepEqual(frames[1].source_ref, { kind: "notebook_execution", execution_count: 2, cell_id: "c2" });
  assert.equal(frames[1].cell_id, "c2");
  assert.deepEqual(payload.execution, { execution_count: 2, cell_id: "c2" });
  assert.equal(payload.text, lines.join("\n"));
  assert.equal(payload.raw_text, stack);
  assert.equal(payload.language, "typescript");
});

test("buildTraceback reads other files, marks libraries and drops what ran the cell", () => {
  const code = "fail(1)";
  const name = cellName(code);
  const stack = [
    "RangeError: bad",
    "    at fail (file:///home/me/lib.ts:2:9)",
    "    at map (/p/node_modules/m/i.js:1:5)",
    `    at ${name}:2:1`,
    "    at handle (file:///k/runtime/evaluator.mjs:48:29)",
    "    at emit (node:events:100:22)",
  ].join("\n");
  const read: string[] = [];
  const { lines, payload } = buildTraceback({ ename: "RangeError", evalue: "bad", stack }, {
    ...cellSources({ [name]: { code, executionCount: null } }),
    readFile: (file) => (read.push(file), file === "file:///home/me/lib.ts" ? "function fail() {\n  throw new RangeError('bad');\n}\n" : undefined),
    kernelFiles: ["file:///k/runtime/"],
  }, { executionCount: null, cellId: null });
  assert.equal(lines[3], "    at cell:1", "a cell run without history has no In[n]");
  assert.equal(lines.length, 6, "the classic lines keep every frame");
  const frames = payload.frames as TracebackFrame[];
  assert.deepEqual(frames.map((f) => [f.filename, f.library]), [["file:///home/me/lib.ts", false], ["/p/node_modules/m/i.js", true], ["cell", false]]);
  assert.deepEqual(frames[0].lines.map((l) => l.lineno), [1, 2, 3], "no line for the file's final newline");
  assert.equal(frames[0].colno, 9);
  assert.deepEqual(read, ["file:///home/me/lib.ts"], "library files aren't read");
  assert.equal(payload.execution, undefined);
});

test("buildTraceback: a stack without cell frames keeps them all; a long one is clipped", () => {
  const stack = ["E: x", ...Array.from({ length: 40 }, (_, i) => `    at f${i} (node:x:${i + 1}:1)`)].join("\n");
  const frames = buildTraceback({ ename: "E", evalue: "x", stack }, { cell: () => undefined }, { executionCount: 1, cellId: null })
    .payload.frames as TracebackFrame[];
  assert.equal(frames.length, 20 + 1 + 10);
  assert.equal(frames[20].name, "… 10 frames omitted …");
  assert.equal(frames[0].name, "f0");
  assert.equal(frames[30].name, "f39");
});

test("buildTraceback without a stack has the error line and no frames", () => {
  const { lines, payload } = buildTraceback({ ename: "Error", evalue: "thrown 1", stack: "" }, { cell: () => undefined }, {
    executionCount: 1,
    cellId: null,
  });
  assert.deepEqual(lines, ["Error: thrown 1"]);
  assert.deepEqual(payload.frames, []);
});

test("buildTraceback names Deno's <anonymous> frames from CDP's call frames", () => {
  const code = "const a = 1;\nnull.x";
  const name = cellName(code);
  const stack = "TypeError: no\n    at f (<anonymous>:4:2)\n    at Array.map (<anonymous>)\n    at <anonymous>:3:6";
  const { lines, payload } = buildTraceback({
    ename: "TypeError",
    evalue: "no",
    stack,
    callFrames: [
      { url: "other.ts", lineNumber: 3, columnNumber: 1 },
      { url: name, lineNumber: 2, columnNumber: 5 },
    ],
  }, cellSources({ [name]: { code, executionCount: 5 } }), { executionCount: 5, cellId: null });
  assert.deepEqual(lines, ["TypeError: no", "    at f (<anonymous>:4:2)", "    at Array.map (<anonymous>)", "    at In[5]:2"]);
  const frames = payload.frames as TracebackFrame[];
  assert.deepEqual(frames.map((f) => f.filename), ["other.ts", "<anonymous>", "In[5]"], "a native frame has no call frame");
});
