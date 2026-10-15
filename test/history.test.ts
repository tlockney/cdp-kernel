// history_request (#10): queryHistory and inspectTarget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { queryHistory, SESSION } from "../src/history.ts";
import { inspectTarget } from "../src/text.ts";

const entries = [
  { line: 1, input: "const a = 1" },
  { line: 2, input: "a + 1" },
  { line: 3, input: "console.log(a)" },
  { line: 4, input: "a + 1" },
];

test("tail returns the last n entries as [session, line, input]", () => {
  assert.deepEqual(queryHistory(entries, { hist_access_type: "tail", n: 2 }), [
    [SESSION, 3, "console.log(a)"],
    [SESSION, 4, "a + 1"],
  ]);
  assert.equal(queryHistory(entries, { hist_access_type: "tail" }).length, 4);
});

test("range selects lines [start, stop) of this session", () => {
  assert.deepEqual(queryHistory(entries, { hist_access_type: "range", session: 0, start: 2, stop: 4 }).map((i) => i[1]), [2, 3]);
  assert.deepEqual(queryHistory(entries, { hist_access_type: "range", start: 3 }).map((i) => i[1]), [3, 4]);
  assert.deepEqual(queryHistory(entries, { hist_access_type: "range", session: 7, start: 1 }), [], "other sessions aren't kept");
});

test("search matches globs, newest n, optionally unique", () => {
  assert.deepEqual(queryHistory(entries, { hist_access_type: "search", pattern: "a + ?" }).map((i) => i[1]), [2, 4]);
  assert.deepEqual(queryHistory(entries, { hist_access_type: "search", pattern: "*a*", unique: true }).map((i) => i[1]), [1, 3, 4]);
  assert.deepEqual(queryHistory(entries, { hist_access_type: "search", pattern: "*", n: 1 }).map((i) => i[1]), [4]);
  assert.deepEqual(queryHistory(entries, { hist_access_type: "search", pattern: "con*" }).map((i) => i[1]), [1, 3]);
  assert.deepEqual(queryHistory(entries, { hist_access_type: "search", pattern: "a.b" }), [], "regex characters are literal");
});

test("an unknown access type returns nothing", () => {
  assert.deepEqual(queryHistory(entries, { hist_access_type: "weird" }), []);
});

test("inspectTarget finds the name at, inside or after the cursor", () => {
  assert.equal(inspectTarget("Math.max", 8), "Math.max");
  assert.equal(inspectTarget("Math.max", 6), "Math.max", "cursor inside the name");
  assert.equal(inspectTarget("x = obj.inner.value + 1", 13), "obj.inner", "right after 'inner'");
  assert.equal(inspectTarget("x = obj.inner.value + 1", 16), "obj.inner.value", "inside 'value'");
  assert.equal(inspectTarget("add(", 4), "add", "the callee, right after the parenthesis");
  assert.equal(inspectTarget("foo(1, add(", 11), "add");
  assert.equal(inspectTarget("obj.", 4), "obj");
});

test("inspectTarget refuses anything that isn't a plain path", () => {
  assert.equal(inspectTarget("f()", 3), null);
  assert.equal(inspectTarget("1 + 1", 5), null);
  assert.equal(inspectTarget("", 0), null);
  assert.equal(inspectTarget("a[0]", 4), null);
});
