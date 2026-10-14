import { test } from "node:test";
import assert from "node:assert/strict";
import { aliasFor, jsrToNpm, parsePackageSpecifier } from "../runtime/node-hooks.mjs";

test("parsePackageSpecifier: plain, range, subpath", () => {
  assert.deepEqual(parsePackageSpecifier("lodash"), { name: "lodash", range: "*", subpath: "" });
  assert.deepEqual(parsePackageSpecifier("lodash@4.17.21"), { name: "lodash", range: "4.17.21", subpath: "" });
  assert.deepEqual(parsePackageSpecifier("lodash/fp"), { name: "lodash", range: "*", subpath: "/fp" });
  assert.deepEqual(parsePackageSpecifier("lodash@^4/fp/map"), { name: "lodash", range: "^4", subpath: "/fp/map" });
});

test("parsePackageSpecifier: scoped packages", () => {
  assert.deepEqual(parsePackageSpecifier("@std/path"), { name: "@std/path", range: "*", subpath: "" });
  assert.deepEqual(parsePackageSpecifier("@std/path@^1"), { name: "@std/path", range: "^1", subpath: "" });
  assert.deepEqual(parsePackageSpecifier("@std/path/posix"), { name: "@std/path", range: "*", subpath: "/posix" });
  assert.deepEqual(parsePackageSpecifier("@std/path@^1/posix"), { name: "@std/path", range: "^1", subpath: "/posix" });
});

test("jsrToNpm maps onto the @jsr npm scope", () => {
  assert.deepEqual(jsrToNpm("@std/path@^1/posix"), { name: "@jsr/std__path", range: "^1", subpath: "/posix" });
  assert.deepEqual(jsrToNpm("@std/path"), { name: "@jsr/std__path", range: "*", subpath: "" });
});

test("jsrToNpm rejects unscoped names", () => {
  assert.throws(() => jsrToNpm("path@1"), TypeError);
});

test("aliasFor is stable and distinct per range", () => {
  assert.equal(aliasFor("left-pad", "^1"), aliasFor("left-pad", "^1"));
  assert.notEqual(aliasFor("left-pad", "^1"), aliasFor("left-pad", "^2"));
  assert.notEqual(aliasFor("left-pad", "^1"), aliasFor("right-pad", "^1"));
  assert.match(aliasFor("left-pad", "^1"), /^cdpk-[0-9a-f]{12}$/);
});
