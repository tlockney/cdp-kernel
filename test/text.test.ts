import { test } from "node:test";
import assert from "node:assert/strict";
import { checkIsComplete, codePointToUtf16Index, exprAtCursor, utf16ToCodePointIndex } from "../src/text.ts";

test("checkIsComplete: complete code", () => {
  for (const code of ["", "1 + 1", "foo(1, [2], { a: 3 })", "const s = 'a'; // c", "`a${1}b`"]) {
    assert.deepEqual(checkIsComplete(code), { status: "complete" }, code);
  }
});

test("checkIsComplete: open brackets are incomplete with indent", () => {
  for (const code of ["foo(", "[1,", "if (x) {", "f({ a: [1,"]) {
    assert.deepEqual(checkIsComplete(code), { status: "incomplete", indent: "  " }, code);
  }
});

test("checkIsComplete: mismatched or stray closers are invalid", () => {
  for (const code of ["(]", "{)", ")", "foo(1))", "[}"]) {
    assert.deepEqual(checkIsComplete(code), { status: "invalid" }, code);
  }
});

test("checkIsComplete: unterminated string, template, block comment", () => {
  for (const code of ["'abc", '"abc', "`abc", "/* abc"]) {
    assert.equal(checkIsComplete(code).status, "incomplete", code);
  }
});

test("checkIsComplete: brackets inside strings and comments are ignored", () => {
  for (const code of ["'('", '")]}"', "`{[(`", "// (((\n1", "/* ( [ { */ 1", "'a' + \"}\" + `)`"]) {
    assert.deepEqual(checkIsComplete(code), { status: "complete" }, code);
  }
});

test("checkIsComplete: escaped quotes do not end a string", () => {
  assert.deepEqual(checkIsComplete("'it\\'s'"), { status: "complete" });
  assert.deepEqual(checkIsComplete('"a\\"b"'), { status: "complete" });
  assert.equal(checkIsComplete("'it\\'s").status, "incomplete");
});

test("exprAtCursor picks the dotted expression before the cursor", () => {
  assert.equal(exprAtCursor("Math.fl", 7), "Math.fl");
  assert.equal(exprAtCursor("x = foo.bar.ba", 14), "foo.bar.ba");
  assert.equal(exprAtCursor("Math.floor(1)", 4), "Math");
  assert.equal(exprAtCursor("a + ", 4), "");
  assert.equal(exprAtCursor("$el._x", 6), "$el._x");
  assert.equal(exprAtCursor("", 0), "");
});

test("codepoint and utf16 conversions with astral characters", () => {
  const s = "a😀b😀c";
  // codepoints: a(0) 😀(1) b(2) 😀(3) c(4); utf16: 0,1,3,4,6
  const pairs: [number, number][] = [[0, 0], [1, 1], [2, 3], [3, 4], [4, 6], [5, 7]];
  for (const [cp, u16] of pairs) {
    assert.equal(codePointToUtf16Index(s, cp), u16, `cp ${cp}`);
    assert.equal(utf16ToCodePointIndex(s, u16), cp, `u16 ${u16}`);
  }
});

test("conversions are the identity for BMP text and clamp past the end", () => {
  assert.equal(codePointToUtf16Index("abc", 2), 2);
  assert.equal(utf16ToCodePointIndex("abc", 2), 2);
  assert.equal(codePointToUtf16Index("abc", 99), 3);
  assert.equal(utf16ToCodePointIndex("abc", 99), 3);
  assert.equal(codePointToUtf16Index("", 5), 0);
});
