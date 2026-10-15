// Inspection text for inspect_request (#10), runtime/introspect.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { describeValue, inspectPath, resolvePath, signatureOf } from "../runtime/introspect.mjs";

test("resolvePath follows a dotted path without calling getters", () => {
  let calls = 0;
  const root = {
    a: { b: { c: 42 } },
    get lazy() {
      calls++;
      return 1;
    },
  };
  assert.deepEqual(resolvePath("a.b.c", root), { found: true, value: 42 });
  assert.deepEqual(resolvePath("lazy", root), { found: true, accessor: true, name: "lazy" });
  assert.equal(calls, 0, "the getter never ran");
  assert.deepEqual(resolvePath("a.missing", root), { found: false });
  assert.deepEqual(resolvePath("a.b.c.d.e", root), { found: false });
});

test("resolvePath finds inherited properties and boxes primitives", () => {
  assert.equal((resolvePath("s.padStart", { s: "x" }) as { value: unknown }).value, String.prototype.padStart);
  assert.equal((resolvePath("Math.max") as { value: unknown }).value, Math.max);
});

test("resolvePath only accepts identifier paths, so nothing is evaluated", () => {
  for (const path of ["f()", "a[0]", "a.b()", "1 + 1", ".a", "a..b", ""]) {
    assert.deepEqual(resolvePath(path, { f() {}, a: [1] }), { found: false }, path);
  }
});

test("signatureOf reads parameters from the source", () => {
  function add(a: number, b = 2) {
    return a + b;
  }
  assert.equal(signatureOf(add), "add(a, b = 2)");
  assert.equal(signatureOf(async function load(url: string) {
    return url;
  }), "async load(url)");
  const arrow = (x: number, y: number) => x + y;
  assert.equal(signatureOf(arrow), "arrow(x, y)");
  assert.equal(signatureOf(Math.max), "max(arg0, arg1)");
  class Point {}
  assert.equal(signatureOf(Point), "class Point");
});

test("signatureOf puts a multi-line parameter list on one line", () => {
  const fn: unknown = (0, eval)("(function spread(\n  first,\n  second = {},\n) {})");
  assert.equal(signatureOf(fn as () => void), "spread(first, second = {},)");
});

test("describeValue summarises a function, with its source at detail 1", () => {
  // Plain JavaScript, as a transformed cell defines it.
  const greet: unknown = (0, eval)("(function greet(name) { return 'hi ' + name; })");
  const brief = describeValue(greet, { inspect });
  assert.match(brief, /^Type: function\nSignature: greet\(name\)\nValue: \[Function: greet\]$/);
  const full = describeValue(greet, { inspect, detail: 1 });
  assert.match(full, /Source:\nfunction greet\(name\) \{ return 'hi ' \+ name; \}$/);
});

test("describeValue summarises objects: type, preview and properties", () => {
  const text = describeValue(new Map([["k", 1]]), { inspect });
  assert.match(text, /^Type: object \(Map\)\nValue: Map\(1\) \{ 'k' => 1 \}$/);
  const obj = describeValue({ a: 1, b: "two" }, { inspect });
  assert.match(obj, /Type: object\nValue: \{ a: 1, b: 'two' \}\nProperties: a, b/);
  assert.match(describeValue(42, { inspect }), /^Type: number\nValue: 42$/);
  assert.match(describeValue(null, { inspect }), /^Type: null/);
  class K {}
  assert.match(describeValue(K, { inspect }), /^Type: class\nSignature: class K/);
});

test("describeValue truncates long previews and long property lists", () => {
  const big = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, "x".repeat(50)]));
  const text = describeValue(big, { inspect });
  assert.match(text, /… \(\d+ more characters\)/);
  assert.match(text, /… \(60 more\)/);
});

test("describeValue survives an inspect that throws", () => {
  const text = describeValue({}, {
    inspect: () => {
      throw new Error("nope");
    },
  });
  assert.match(text, /\(inspect failed: nope\)/);
});

test("inspectPath reports accessors instead of calling them", () => {
  const root = {
    get g() {
      throw new Error("must not run");
    },
    v: [1, 2],
  };
  assert.match(inspectPath("g", { inspect, root }) ?? "", /accessor property\ng has a getter/);
  assert.match(inspectPath("v", { inspect, root }) ?? "", /Type: object \(Array\)\nValue: \[ 1, 2 \]/);
  assert.equal(inspectPath("nothing", { inspect, root }), null);
});
