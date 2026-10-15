import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDenoConfig, loadDenoProject, parseJsonc, transformOptionsFromConfig } from "../src/deno-config.ts";

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "cdpk-denocfg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("findDenoConfig walks up from the notebook directory", (t) => {
  const root = tempDir(t);
  writeFileSync(join(root, "deno.jsonc"), "{}");
  const nested = join(root, "notebooks", "2026");
  mkdirSync(nested, { recursive: true });
  assert.equal(findDenoConfig(nested), join(root, "deno.jsonc"));
});

test("findDenoConfig prefers deno.json over deno.jsonc in the same directory", (t) => {
  const root = tempDir(t);
  writeFileSync(join(root, "deno.json"), "{}");
  writeFileSync(join(root, "deno.jsonc"), "{}");
  assert.equal(findDenoConfig(root), join(root, "deno.json"));
});

test("findDenoConfig takes the nearest config, not an outer one", (t) => {
  const root = tempDir(t);
  writeFileSync(join(root, "deno.json"), "{}");
  const inner = join(root, "inner");
  mkdirSync(inner);
  writeFileSync(join(inner, "deno.json"), "{}");
  assert.equal(findDenoConfig(inner), join(inner, "deno.json"));
});

test("findDenoConfig returns null when no config exists up to the root", (t) => {
  const root = tempDir(t);
  // A temp dir's ancestors normally hold no deno.json; check that explicitly
  // rather than assume it.
  const found = findDenoConfig(root);
  assert.ok(found === null || !found.startsWith(root), String(found));
});

test("parseJsonc handles comments, trailing commas and comment-like strings", () => {
  const text = `{
    // line comment
    "imports": { "@/": "./lib/", }, /* block
    comment */
    "url": "https://example.com/a//b", // slashes inside a string stay
    "star": "/* not a comment */",
    "esc": "quote \\" and // still a string",
    "list": [1, 2, 3,],
  }`;
  assert.deepEqual(parseJsonc(text), {
    imports: { "@/": "./lib/" },
    url: "https://example.com/a//b",
    star: "/* not a comment */",
    esc: 'quote " and // still a string',
    list: [1, 2, 3],
  });
});

test("parseJsonc rejects invalid JSON with a readable error", () => {
  assert.throws(() => parseJsonc("{ imports: {} }"), SyntaxError);
});

test("transformOptionsFromConfig maps Deno's JSX settings onto esbuild's", () => {
  assert.deepEqual(transformOptionsFromConfig({}), {});
  assert.deepEqual(
    transformOptionsFromConfig({ compilerOptions: { jsx: "react-jsx", jsxImportSource: "npm:preact" } }),
    { jsx: { mode: "automatic", importSource: "npm:preact", development: false } },
  );
  assert.deepEqual(
    transformOptionsFromConfig({ compilerOptions: { jsx: "react-jsxdev", jsxImportSource: "preact" } }),
    { jsx: { mode: "automatic", importSource: "preact", development: true } },
  );
  // precompile is Deno's server-side optimisation of the automatic runtime.
  assert.deepEqual(
    transformOptionsFromConfig({ compilerOptions: { jsx: "precompile", jsxImportSource: "hono/jsx" } }),
    { jsx: { mode: "automatic", importSource: "hono/jsx", development: false } },
  );
  assert.deepEqual(
    transformOptionsFromConfig({ compilerOptions: { jsx: "react", jsxFactory: "h", jsxFragmentFactory: "Fragment" } }),
    { jsx: { mode: "classic", factory: "h", fragment: "Fragment" } },
  );
  assert.deepEqual(
    transformOptionsFromConfig({ compilerOptions: { experimentalDecorators: true } }),
    { experimentalDecorators: true },
  );
});

test("transformOptionsFromConfig ignores malformed compilerOptions", () => {
  assert.deepEqual(transformOptionsFromConfig({ compilerOptions: "nope" }), {});
  assert.deepEqual(transformOptionsFromConfig({ compilerOptions: { jsx: 7, jsxImportSource: ["x"] } }), {});
  assert.deepEqual(transformOptionsFromConfig(null), {});
});

test("loadDenoProject reads the nearest config", (t) => {
  const root = tempDir(t);
  writeFileSync(
    join(root, "deno.jsonc"),
    '{ // project\n "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "my-jsx" } }',
  );
  assert.deepEqual(loadDenoProject(root), {
    configPath: join(root, "deno.jsonc"),
    transform: { jsx: { mode: "automatic", importSource: "my-jsx", development: false } },
  });
});

test("loadDenoProject returns null outside a Deno project", (t) => {
  const root = tempDir(t);
  const project = loadDenoProject(root);
  assert.ok(project === null || !project.configPath.startsWith(root));
});

test("loadDenoProject reports a broken config with its path", (t) => {
  const root = tempDir(t);
  writeFileSync(join(root, "deno.json"), "{ not json");
  assert.throws(() => loadDenoProject(root), (err: unknown) => {
    return err instanceof Error && err.message.includes(join(root, "deno.json"));
  });
});
