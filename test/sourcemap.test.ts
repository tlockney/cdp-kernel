// Line mapping between a cell and its script, for the debugger (#18).
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeVlq, generatedToOriginalLines, LineMap } from "../src/sourcemap.ts";
import { rewriteModuleSyntax, transformCellWithLines } from "../src/transform.ts";

test("decodeVlq reads signed base64 VLQ fields", () => {
  assert.deepEqual(decodeVlq("AAAA"), [0, 0, 0, 0]);
  assert.deepEqual(decodeVlq("AACA"), [0, 0, 1, 0]);
  assert.deepEqual(decodeVlq("D"), [-1]);
  assert.deepEqual(decodeVlq("gB"), [16], "a continuation digit");
  assert.throws(() => decodeVlq("!"), /bad base64 VLQ digit/);
});

test("generatedToOriginalLines tracks the relative original line", () => {
  // Line 0 -> 0; line 1 empty; line 2 -> 2 (delta +2); line 3 -> 1 (delta -1).
  assert.deepEqual(generatedToOriginalLines("AAAA;;AAEA;AADA"), [0, -1, 2, 1]);
});

test("LineMap: an offset, the nearest mapped line, and breakpoints that move down", () => {
  const lines = new LineMap("AAAA;;AAEA", 1); // script: [prelude, 0, -, 2]
  assert.equal(lines.toOriginal(1), 0);
  assert.equal(lines.toOriginal(2), 0, "an unmapped line takes the one above");
  assert.equal(lines.toOriginal(3), 2);
  assert.equal(lines.toOriginal(0), 0, "the prelude counts as the first line");
  assert.equal(lines.toGenerated(0), 1);
  assert.equal(lines.toGenerated(1), 3, "line 1 has no code: the breakpoint moves to line 2");
  assert.equal(lines.toGenerated(5), null, "past the end");
});

test("LineMap: a mapped line left blank counts as unmapped", () => {
  // A stripper that keeps lines (sucrase) maps every line to itself,
  // including the ones it blanks: here an interface on lines 0-2.
  const generated = "\n\n\nconst a = 1;";
  const lines = new LineMap("AAAA;AACA;AACA;AACA", 0, generated);
  assert.equal(lines.toGenerated(0), 3, "a breakpoint on the interface moves to the next statement");
  assert.equal(lines.toGenerated(3), 3);
  assert.equal(lines.toOriginal(3), 3);
  assert.equal(new LineMap("AAAA;AACA;AACA;AACA").toGenerated(0), 0, "without the output, every mapping counts");
});

test("rewritten imports keep the lines after them in place", () => {
  const js = 'import {\n  a,\n  b,\n} from "m";\nconst c = a + b;';
  const out = rewriteModuleSyntax(js);
  assert.equal(out.split("\n").length, js.split("\n").length);
  assert.equal(out.split("\n")[4], "const c = a + b;");
});

test("transformCellWithLines maps each statement of a TypeScript cell both ways", () => {
  const cell = [
    'import {', //               0
    '  join,', //                1
    '} from "node:path";', //    2
    "interface Point {", //      3
    "  x: number;", //           4
    "}", //                      5
    "", //                       6
    "const first: number = 1;", // 7
    "type Alias = string;", //   8
    "const second = first + 1;", // 9
    "// a comment", //           10
    "second * 2", //             11
  ].join("\n");
  const { script, lines } = transformCellWithLines(cell);
  const scriptLines = script.split("\n");
  for (const [needle, original] of [["first = 1", 7], ["second = first + 1", 9], ["second * 2", 11]] as const) {
    const generated = scriptLines.findIndex((l) => l.includes(needle));
    assert.ok(generated > 0, `${needle} is in the script`);
    assert.equal(lines.toGenerated(original), generated, `line ${original} -> ${generated}`);
    assert.equal(lines.toOriginal(generated), original, `line ${generated} -> ${original}`);
  }
  const firstLine = scriptLines.findIndex((l) => l.includes("first = 1"));
  assert.equal(lines.toGenerated(3), firstLine, "a breakpoint in a type-only block moves to the next statement");
  assert.equal(lines.toGenerated(6), firstLine, "and so does one on a blank line");
});
