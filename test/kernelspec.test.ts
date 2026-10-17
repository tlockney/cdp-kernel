// `cdp-kernel list` and `uninstall` manage kernelspecs without Jupyter (#249).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

function cli(dataDir: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [MAIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, JUPYTER_DATA_DIR: dataDir },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function dataDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "cdpk-specs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A kernelspec another kernel wrote, which list and uninstall must leave alone.
function foreignSpec(dir: string, name: string): string {
  const spec = join(dir, "kernels", name);
  mkdirSync(spec, { recursive: true });
  writeFileSync(join(spec, "kernel.json"), JSON.stringify({ argv: ["python", "-m", "ipykernel", "-f", "{connection_file}"], language: "python" }));
  return spec;
}

test("list shows only cdp-kernel kernelspecs, with runtime and version", (t) => {
  const dir = dataDir(t);
  assert.match(cli(dir, "list").stdout, /no cdp-kernel kernelspecs/);
  assert.equal(cli(dir, "install", "--runtime", "node").status, 0);
  assert.equal(cli(dir, "install", "--runtime", "deno", "--name", "my-deno").status, 0);
  foreignSpec(dir, "python3");
  const r = cli(dir, "list");
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 2, r.stdout);
  assert.match(lines[0], new RegExp(`^cdp-node\\s+node\\s+\\S+\\s+${join(dir, "kernels", "cdp-node").replace(/\\/g, "\\\\")}$`));
  assert.match(lines[1], /^my-deno\s+deno\s/);
});

test("uninstall removes named kernelspecs and refuses others'", (t) => {
  const dir = dataDir(t);
  cli(dir, "install", "--runtime", "node");
  cli(dir, "install", "--runtime", "bun");
  const python = foreignSpec(dir, "python3");

  let r = cli(dir, "uninstall", "cdp-node");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /removed kernelspec cdp-node/);
  assert.ok(!existsSync(join(dir, "kernels", "cdp-node")));
  assert.ok(existsSync(join(dir, "kernels", "cdp-bun")));

  r = cli(dir, "uninstall", "--name", "python3");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /wasn't installed by cdp-kernel/);
  assert.ok(existsSync(python));

  r = cli(dir, "uninstall", "missing");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no kernelspec missing/);

  r = cli(dir, "uninstall", "../kernels");
  assert.equal(r.status, 1);
  assert.ok(existsSync(join(dir, "kernels")));
});

test("uninstall with no name lists what's installed; --all removes only cdp-kernel's", (t) => {
  const dir = dataDir(t);
  cli(dir, "install", "--runtime", "node");
  cli(dir, "install", "--runtime", "node", "--deno-compat");
  const python = foreignSpec(dir, "python3");

  let r = cli(dir, "uninstall");
  assert.equal(r.status, 2);
  assert.match(r.stdout, /cdp-node-deno/);
  assert.ok(existsSync(join(dir, "kernels", "cdp-node")));

  r = cli(dir, "uninstall", "--all");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /removed kernelspec cdp-node\b/);
  assert.match(r.stdout, /removed kernelspec cdp-node-deno/);
  assert.ok(existsSync(python));
  assert.match(cli(dir, "list").stdout, /no cdp-kernel kernelspecs/);

  r = cli(dir, "uninstall", "--all");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no cdp-kernel kernelspecs/);
});
