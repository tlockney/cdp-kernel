// `cdp-kernel list` and `uninstall` manage kernelspecs without Jupyter (#249).
// `install` takes the same names (#338).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("install refuses a name that isn't a kernel name", (t) => {
  const dir = dataDir(t);
  for (const name of ["../evil", "a/b", "..", ".", ""]) {
    const r = cli(dir, "install", "--name", name);
    assert.equal(r.status, 2, name);
    assert.match(r.stderr, /invalid kernelspec name/);
  }
  assert.ok(!existsSync(join(dir, "evil")));
  assert.ok(!existsSync(join(dir, "kernels")));
});

test("--help prints the usage; an unknown option says which, without a stack trace", (t) => {
  const dir = dataDir(t);
  for (const arg of ["--help", "-h", "help"]) {
    const r = cli(dir, arg);
    assert.equal(r.status, 0, arg);
    assert.match(r.stdout, /^usage: cdp-kernel install/, arg);
  }
  const r = cli(dir, "install", "--bogus");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^cdp-kernel: Unknown option '--bogus'\nusage: cdp-kernel/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
  assert.ok(!existsSync(join(dir, "kernels")), "nothing was installed");
});

test("install --pin keeps the exact node; a checkout isn't copied", (t) => {
  const dir = dataDir(t);
  const r = cli(dir, "install", "--pin");
  assert.equal(r.status, 0, r.stderr);
  const argv = JSON.parse(readFileSync(join(dir, "kernels", "cdp-node", "kernel.json"), "utf8")).argv;
  assert.equal(argv[0], process.execPath);
  assert.equal(argv[1], MAIN);
  assert.ok(!existsSync(join(dir, "cdp-kernel")), "a checkout runs in place");
});

test("install keeps other versions' package copies; uninstall prunes unused ones and nothing else (#508)", (t) => {
  const dir = dataDir(t);
  const root = join(dir, "cdp-kernel");
  // A spec running 0.2.0's copy, as an npm install writes.
  cli(dir, "install", "--runtime", "node");
  for (const d of ["0.1.0", "0.2.0", "keep-me"]) mkdirSync(join(root, d), { recursive: true });
  const file = join(dir, "kernels", "cdp-node", "kernel.json");
  const spec = JSON.parse(readFileSync(file, "utf8"));
  spec.argv[1] = join(root, "0.2.0", "dist", "main.js");
  writeFileSync(file, JSON.stringify(spec));

  // Installing (here a checkout's version over it) must not remove copies
  // that running kernels may still use.
  const r = cli(dir, "install", "--runtime", "bun");
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /removed/);
  assert.ok(existsSync(join(root, "0.1.0")));
  assert.ok(existsSync(join(root, "0.2.0")));

  // cdp-bun runs the checkout, so only cdp-node's 0.2.0 is referenced.
  let u = cli(dir, "uninstall", "cdp-bun");
  assert.equal(u.status, 0, u.stderr);
  assert.match(u.stdout, /removed unused package copy .*0\.1\.0/);
  assert.ok(!existsSync(join(root, "0.1.0")));
  assert.ok(existsSync(join(root, "0.2.0")));

  u = cli(dir, "uninstall", "--all");
  assert.equal(u.status, 0, u.stderr);
  assert.ok(!existsSync(join(root, "0.2.0")));
  assert.ok(existsSync(join(root, "keep-me")));
});

test("install names a version manager's shim, and --pin the exact node", (t) => {
  if (process.platform === "win32") return t.skip("no shims on Windows");
  const tmpRoot = dataDir(t);
  const bin = join(tmpRoot, "mise", "installs", "node", "22.0.0", "bin");
  const shims = join(tmpRoot, "mise", "shims");
  mkdirSync(bin, { recursive: true });
  mkdirSync(shims, { recursive: true });
  const node = join(bin, "node");
  try {
    linkSync(process.execPath, node);
  } catch {
    copyFileSync(process.execPath, node);
  }
  const shim = join(shims, "node");
  writeFileSync(shim, "#!/bin/sh\n");
  chmodSync(shim, 0o755);
  const data = join(tmpRoot, "data");
  const run = (...args: string[]) => {
    const r = spawnSync(node, [MAIN, "install", ...args], { encoding: "utf8", env: { ...process.env, JUPYTER_DATA_DIR: data } });
    assert.equal(r.status, 0, r.stderr);
    return { argv: JSON.parse(readFileSync(join(data, "kernels", "cdp-node", "kernel.json"), "utf8")).argv, out: r.stdout };
  };
  let r = run();
  assert.equal(r.argv[0], shim);
  assert.match(r.out, new RegExp(`runs node via ${shim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(--pin to use`));
  r = run("--pin");
  assert.equal(r.argv[0], node);
  assert.match(r.out, /\(pinned\)/);
});
