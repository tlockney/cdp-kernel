import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJupyter } from "../runtime/display.mjs";
import type { JupyterNamespace } from "../src/globals.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = join(root, "test", "fixtures", "globals");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

function typeCheck(project: string, cwd = root): { ok: boolean; output: string } {
  const result = spawnSync(process.execPath, [tsc, "-p", project], { cwd, encoding: "utf8" });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

test("globals entry type-checks notebook usage and rejects misuse", () => {
  const { ok, output } = typeCheck(join(fixtures, "tsconfig.json"));
  assert.ok(ok, output);
});

test("deno-compat globals entry types the Deno namespace", () => {
  const { ok, output } = typeCheck(join(fixtures, "tsconfig.deno-compat.json"));
  assert.ok(ok, output);
});

test("declared jupyter namespace matches the runtime namespace", () => {
  // `satisfies` makes this list exhaustive at compile time: a key missing
  // from it, or one the interface doesn't declare, is a type error.
  const declared = {
    broadcast: true,
    display: true,
    format: true,
    md: true,
    html: true,
    svg: true,
    image: true,
    $display: true,
    comm: true,
    widget: true,
  } satisfies Record<keyof JupyterNamespace, true>;
  const runtime = createJupyter({
    inspect: String,
    base64: () => "",
    readFile: () => new Uint8Array(),
    send: () => {},
    input: () => null,
  }).namespace;
  assert.deepEqual(Object.keys(runtime).sort(), Object.keys(declared).sort());
});

test("the packed npm package exposes the globals to a consumer", (t) => {
  const work = mkdtempSync(join(tmpdir(), "cdpk-types-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  // npm is npm.cmd on Windows, which only a shell resolves (#32).
  const shell = process.platform === "win32";
  const pack = spawnSync("npm", ["pack", "--silent", "--pack-destination", work], { cwd: root, encoding: "utf8", shell });
  assert.equal(pack.status, 0, String(pack.stderr ?? pack.error));
  const tarball = join(work, pack.stdout.trim().split(/\r?\n/).pop() ?? "");
  const consumer = join(work, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, "package.json"), '{ "private": true, "type": "module" }\n');
  const install = spawnSync("npm", ["install", "--silent", "--no-audit", "--no-fund", "--ignore-scripts", tarball], {
    cwd: consumer,
    encoding: "utf8",
    shell,
  });
  assert.equal(install.status, 0, String(install.stderr ?? install.error));
  writeFileSync(
    join(consumer, "cell.ts"),
    [
      '/// <reference types="@tlockney/cdp-kernel/globals" />',
      "await jupyter.display(jupyter.md`from the package`);",
      'const answer: string | null = prompt("q", "", { password: true });',
      "export { answer };",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "esnext", module: "nodenext", strict: true, noEmit: true, types: [] },
      files: ["cell.ts"],
    }),
  );
  const { ok, output } = typeCheck(join(consumer, "tsconfig.json"), consumer);
  assert.ok(ok, output);
});

const hasDeno = spawnSync("deno", ["--version"]).status === 0;

test("the runtime namespace covers every member of Deno's Deno.jupyter type", {
  skip: hasDeno ? false : "deno not on PATH",
}, () => {
  const result = spawnSync("deno", ["run", "--check", "--quiet", join(fixtures, "deno-jupyter-keys.ts")], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.stdout.trim(), "ok");
});
