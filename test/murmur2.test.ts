// murmur2 must agree with what JupyterLab and ipykernel compute, or the
// debugger's breakpoints land on a different "file" than the cell (#18).
// Expected values are ipykernel.compiler.murmur2_x86's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { murmur2 } from "../src/murmur2.ts";

test("murmur2 matches ipykernel's murmur2_x86", () => {
  const vectors: [string, number, number][] = [
    ["", 0, 0],
    ["a", 0, 2456313694],
    ["abc", 3339675911, 3350977461],
    ["abcd", 1, 3376380438],
    ["abcde", 1, 3469237630],
    ["hello world", 3339675911, 3537592377],
    ["const x = 1;\nx + 1", 3339675911, 2374132807],
    ["héllo ✓ 日本", 42, 865804814],
  ];
  for (const [text, seed, expected] of vectors) assert.equal(murmur2(text, seed), expected, JSON.stringify(text));
});
