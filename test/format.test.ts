// The browser Worker's stand-ins for util.inspect and util.format
// (runtime/format.mjs), and where its imports load from (runtime/cdn.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect as nodeInspect, format as nodeFormat } from "node:util";
import { format, inspect } from "../runtime/format.mjs";
import { resolveSpecifier } from "../runtime/cdn.mjs";

test("inspect shows common values as util.inspect does", () => {
  class Point {
    x = 1;
    y = 2;
  }
  const values: unknown[] = [
    1, -0, 10n, "it's", true, null, undefined, Symbol("s"),
    [1, "a", [2, [3]]], { a: 1, "b-c": { d: { e: { f: 1 } } } },
    new Map([["k", 1]]), new Set([1, 2]), new Uint8Array([1, 2]), new Point(),
    function named() {}, () => {}, class Klass {},
  ];
  for (const value of values) assert.equal(inspect(value), nodeInspect(value, { breakLength: Infinity }), String(value));
});

test("inspect marks circular references and stops at depth", () => {
  const o: { [k: string]: unknown } = { a: 1 };
  o.self = o;
  assert.equal(inspect(o), "{ a: 1, self: [Circular *1] }");
  assert.equal(inspect({ a: { b: { c: { d: 1 } } } }), "{ a: { b: { c: [Object] } } }");
});

test("format substitutes and joins as console.log does", () => {
  for (const args of [["a", 1, { b: 2 }], ["%s is %d", "x", 4, "rest"], ["100%%"], ["%j", { a: 1 }]]) {
    assert.equal(format(...args), nodeFormat(...args), JSON.stringify(args));
  }
});

test("resolveSpecifier sends packages to the CDN and resolves the rest as URLs", () => {
  const base = "https://example.com/nb/$cdpk$repl.mjs";
  const cdn = "https://esm.sh/";
  assert.equal(resolveSpecifier("npm:date-fns@4", base, cdn), "https://esm.sh/date-fns@4");
  assert.equal(resolveSpecifier("jsr:@std/path@1", base, cdn), "https://esm.sh/jsr/@std/path@1");
  assert.equal(resolveSpecifier("lodash-es", base, cdn), "https://esm.sh/lodash-es");
  assert.equal(resolveSpecifier("./util.mjs", base, cdn), "https://example.com/nb/util.mjs");
  assert.equal(resolveSpecifier("../x.mjs", base, cdn), "https://example.com/x.mjs");
  assert.equal(resolveSpecifier("https://cdn.example/m.js", base, cdn), "https://cdn.example/m.js");
});
