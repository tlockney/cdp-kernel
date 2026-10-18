// Deno targets' imports for the language service (#275), src/deno-types.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { DenoResolver, type RunDeno } from "../src/deno-types.ts";
import { kernelGlobals, NotebookTypes } from "../src/notebook-types.ts";

/** `deno info --json` output for one import, shaped like Deno 2.9's. */
function info(dep: { specifier: string; code: string }, extra: object) {
  return JSON.stringify({
    roots: ["file:///tmp/entry.ts"],
    modules: [{ specifier: "file:///tmp/entry.ts", dependencies: [{ specifier: dep.specifier, code: { specifier: dep.code } }] }],
    redirects: {},
    npmPackages: {},
    ...extra,
  });
}

test("an npm: import maps to its directory in Deno's npm cache", () => {
  const calls: string[][] = [];
  const run: RunDeno = (args) => {
    calls.push(args);
    return {
      status: 0,
      stdout: info({ specifier: "zod", code: "npm:zod@^3" }, {
        redirects: { "npm:zod@^3": "npm:/zod@3.25.76/v4" },
        npmPackages: { "zod@3.25.76": { localPath: "/deno/npm/registry.npmjs.org/zod/3.25.76" } },
      }),
    };
  };
  const resolver = new DenoResolver({ root: "/nb/__cdpk_remote__", config: "/nb/deno.json" }, run);
  assert.deepEqual(resolver.lookup("zod"), { kind: "npm", dir: "/deno/npm/registry.npmjs.org/zod/3.25.76", subpath: "/v4" });
  assert.deepEqual(resolver.lookup("zod"), { kind: "npm", dir: "/deno/npm/registry.npmjs.org/zod/3.25.76", subpath: "/v4" });
  assert.equal(calls.length, 1, "looked up once");
  assert.deepEqual(calls[0].slice(0, 5), ["info", "--json", "--no-lock", "--config", "/nb/deno.json"]);
});

test("a jsr: import maps to a virtual path over Deno's hashed cache files", () => {
  const run: RunDeno = () => ({
    status: 0,
    stdout: info({ specifier: "jsr:@std/text@1", code: "jsr:@std/text@1" }, {
      redirects: { "jsr:@std/text@1": "https://jsr.io/@std/text/1.1.0/mod.ts" },
      modules: [
        { specifier: "file:///tmp/entry.ts", dependencies: [{ specifier: "jsr:@std/text@1", code: { specifier: "jsr:@std/text@1" } }] },
        { specifier: "https://jsr.io/@std/text/1.1.0/mod.ts", local: "/deno/remote/aaaa" },
        { specifier: "https://jsr.io/@std/text/1.1.0/to_camel_case.ts", local: "/deno/remote/bbbb" },
      ],
    }),
  });
  const resolver = new DenoResolver({ root: "/nb/__cdpk_remote__" }, run);
  const path = "/nb/__cdpk_remote__/https/jsr.io/@std/text/1.1.0/mod.ts";
  assert.deepEqual(resolver.lookup("jsr:@std/text@1"), { kind: "remote", path });
  assert.equal(resolver.localFile(path), "/deno/remote/aaaa");
  assert.equal(resolver.localFile("/nb/__cdpk_remote__/https/jsr.io/@std/text/1.1.0/to_camel_case.ts"), "/deno/remote/bbbb");
});

test("a failed lookup is no resolution", () => {
  const resolver = new DenoResolver({ root: "/nb/r" }, () => ({ status: 1, stdout: "" }));
  assert.equal(resolver.lookup("npm:nope@1"), null);
});

test("the language service reads remote modules through the virtual paths", () => {
  const cache = mkdtempSync(join(tmpdir(), "cdpk-deno-cache-"));
  writeFileSync(join(cache, "aaaa"), `export * from "./to_camel_case.ts";\n`);
  writeFileSync(join(cache, "bbbb"), `/** Converts to camelCase. */\nexport function toCamelCase(input: string): string { return input; }\n`);
  const notebookDir = mkdtempSync(join(tmpdir(), "cdpk-nb-"));
  const run: RunDeno = () => ({
    status: 0,
    stdout: info({ specifier: "jsr:@std/text@1", code: "jsr:@std/text@1" }, {
      redirects: { "jsr:@std/text@1": "https://jsr.io/@std/text/1.1.0/mod.ts" },
      modules: [
        { specifier: "file:///tmp/entry.ts", dependencies: [{ specifier: "jsr:@std/text@1", code: { specifier: "jsr:@std/text@1" } }] },
        { specifier: "https://jsr.io/@std/text/1.1.0/mod.ts", local: join(cache, "aaaa") },
        { specifier: "https://jsr.io/@std/text/1.1.0/to_camel_case.ts", local: join(cache, "bbbb") },
      ],
    }),
  });
  const deno = new DenoResolver({ root: join(notebookDir, "__cdpk_remote__") }, run);
  const types = new NotebookTypes(ts, { notebookDir, npmCache: null, deno, types: [], typeFiles: [], globals: kernelGlobals(null) });
  // Not executed yet: never looked up, so nothing is fetched for it.
  const unrun = `import { toCamelCase } from "jsr:@std/text@1";\ntoCamelCase`;
  assert.equal(types.quickInfo(unrun, unrun.length), null);
  types.addCell(`import { toCamelCase } from "jsr:@std/text@1";`);
  assert.equal(types.quickInfo("toCamelCase", 11), "(alias) function toCamelCase(input: string): string\nConverts to camelCase.");
});
