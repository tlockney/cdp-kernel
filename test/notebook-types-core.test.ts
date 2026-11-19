// NotebookTypesCore (#524): the language service on a file system and path
// helpers it is given, with no Node imports of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { kernelGlobals, NotebookTypesCore, posixJoin, type TypesFileSystem } from "../src/notebook-types-core.ts";

const LIB = dirname(ts.getDefaultLibFilePath({}));

test("posixJoin joins and resolves . and ..", () => {
  assert.equal(posixJoin("/notebook", "__cdpk_notebook__.ts"), "/notebook/__cdpk_notebook__.ts");
  assert.equal(posixJoin("/a/b", "../c", "./d.ts"), "/a/c/d.ts");
  assert.equal(posixJoin("/a", "/b//c/"), "/a/b/c");
  assert.equal(posixJoin("/", "x"), "/x");
  assert.equal(posixJoin("/a", "../../x"), "/x");
  assert.equal(posixJoin("a", "../../x"), "../x");
});

/** A file system with only the lib files, which records every path it is asked about. */
function memory() {
  const files = new Map<string, string>();
  for (const name of readdirSync(LIB)) if (/^lib\..*\.d\.ts$/.test(name)) files.set(`/lib/${name}`, readFileSync(join(LIB, name), "utf8"));
  const asked: string[] = [];
  const fs: TypesFileSystem = {
    readFile: (path) => (asked.push(path), files.get(path)),
    fileExists: (path) => (asked.push(path), files.has(path)),
    directoryExists: (path) => (asked.push(path), [...files.keys()].some((f) => f.startsWith(`${path}/`))),
    getDirectories: () => [],
  };
  return { fs, asked };
}

test("completes and checks types from files the host supplies, reading nothing else", () => {
  const { fs, asked } = memory();
  const types = new NotebookTypesCore(ts, {
    notebookDir: "/notebook",
    npmCache: null,
    types: [],
    typeFiles: [],
    globals: kernelGlobals(null),
  }, { fs, join: posixJoin, libDir: "/lib" });
  types.addCell("const u = { name: 'x' } as { name: string; age?: number };");
  assert.deepEqual(types.complete("u.", 2).entries.map((e) => e.name), ["age", "name"]);
  assert.deepEqual(types.diagnostics("const n: string = u.age;", 5_000)?.map((d) => d.code), [2322]);
  assert.ok(asked.length > 0);
  // Every lookup was in the host's world: the notebook directory or the libs.
  assert.deepEqual(asked.filter((p) => !p.startsWith("/notebook") && !p.startsWith("/lib")), []);
  // The ES libs were read from /lib, not from where typescript.js is.
  assert.ok(asked.includes("/lib/lib.esnext.d.ts"));
});
