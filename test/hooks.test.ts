import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { aliasFor, installCommand, jsrToNpm, parsePackageSpecifier } from "../runtime/node-hooks.mjs";
import { hasBun } from "./bun.ts";

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

test("installCommand: npm for Node, this runtime's own bun for Bun, both saving exactly (#40)", () => {
  assert.deepEqual(installCommand("npm", "cdpk-x", "is-odd", "3.0.1"), {
    cmd: "npm",
    args: ["install", "--no-audit", "--no-fund", "--loglevel=error", "--save-exact", "cdpk-x@npm:is-odd@3.0.1"],
  });
  assert.deepEqual(installCommand("bun", "cdpk-x", "@jsr/std__text", "1"), {
    cmd: process.execPath,
    args: ["add", "--silent", "--exact", "cdpk-x@npm:@jsr/std__text@1"],
  });
});

test("installCommand lets npm fetch JSR's tarballs, and only JSR's (#39)", () => {
  // npm 12 refuses npm.jsr.io tarballs as "remote" packages by default.
  assert.deepEqual(installCommand("npm", "cdpk-j", "@jsr/std__fmt", "1").env, { npm_config_allow_remote: "root" });
  assert.equal(installCommand("npm", "cdpk-n", "is-odd", "3").env, undefined, "npm packages keep npm's default");
  assert.equal(installCommand("bun", "cdpk-b", "@jsr/std__fmt", "1").env, undefined);
});

test("node-hooks.mjs loads in Bun, which has no module.registerHooks", { skip: !hasBun() }, () => {
  const url = new URL("../runtime/node-hooks.mjs", import.meta.url).href;
  const script = `const m = await import(${JSON.stringify(url)}); console.log(typeof m.ensureInstalled)`;
  assert.equal(execFileSync("bun", ["-e", script], { encoding: "utf8" }).trim(), "function");
});
