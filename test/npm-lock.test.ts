// Reproducible, serialized npm:/jsr: installs (#14), runtime/node-hooks.mjs.
// The installer is a fake that writes the package's package.json, so these
// run offline; e2e's npm_import/jsr_import cover the real registries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aliasFor,
  ensureInstalled,
  findLockFile,
  type InstallRunner,
  LOCK_FILE,
  readLock,
  withInstallLock,
  writeLock,
} from "../runtime/node-hooks.mjs";

function scratch(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "cdpk-lock-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The npm cache for this test, via CDPK_CACHE_DIR. */
function useCache(t: { after(fn: () => void): void }, dir: string): string {
  const cache = join(dir, "cache");
  const before = process.env.CDPK_CACHE_DIR;
  process.env.CDPK_CACHE_DIR = cache;
  t.after(() => {
    if (before === undefined) delete process.env.CDPK_CACHE_DIR;
    else process.env.CDPK_CACHE_DIR = before;
  });
  return cache;
}

/** A fake npm: "installs" alias@npm:name@version, resolving ranges to `resolved`. */
function fakeInstaller(resolved: string, calls: string[] = []): InstallRunner {
  return (_cmd, args, cwd) => {
    const spec = args[args.length - 1];
    calls.push(spec);
    const m = /^([^@]+)@npm:(.+)@([^@]+)$/.exec(spec);
    if (!m) return { status: 1, stderr: `bad spec ${spec}` };
    const [, alias, name, version] = m;
    mkdirSync(join(cwd, "node_modules", alias), { recursive: true });
    const exact = /^\d+\.\d+\.\d+$/.test(version) ? version : resolved;
    writeFileSync(join(cwd, "node_modules", alias, "package.json"), JSON.stringify({ name, version: exact }));
    return { status: 0 };
  };
}

test("findLockFile finds the nearest cdp-kernel.lock.json", (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, "a", "b"), { recursive: true });
  assert.equal(findLockFile(join(dir, "a", "b")), null);
  writeFileSync(join(dir, LOCK_FILE), "{}");
  assert.equal(findLockFile(join(dir, "a", "b")), join(dir, LOCK_FILE));
});

test("readLock treats {} as empty; writeLock sorts entries", (t) => {
  const path = join(scratch(t), LOCK_FILE);
  writeFileSync(path, "{}");
  assert.deepEqual(readLock(path), { version: 1, packages: {} });
  writeLock(path, { version: 1, packages: { "zod@^3": "3.23.8", "is-odd@^3": "3.0.1" } });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8")).packages), ["is-odd@^3", "zod@^3"]);
});

test("without a lockfile, a range installs once and is reused", (t) => {
  const dir = scratch(t);
  const cache = useCache(t, dir);
  const calls: string[] = [];
  const run = fakeInstaller("3.0.1", calls);
  const first = ensureInstalled({ name: "is-odd", range: "^3" }, "npm", { run });
  assert.equal(first.dir, cache);
  assert.equal(first.alias, aliasFor("is-odd", "^3"));
  ensureInstalled({ name: "is-odd", range: "^3" }, "npm", { run });
  assert.deepEqual(calls, [`${aliasFor("is-odd", "^3")}@npm:is-odd@^3`]);
});

test("with an empty lockfile, the first resolution is recorded", (t) => {
  const dir = scratch(t);
  useCache(t, dir);
  const lockFile = join(dir, LOCK_FILE);
  writeFileSync(lockFile, "{}\n");
  ensureInstalled({ name: "is-odd", range: "^3" }, "npm", { lockFile, run: fakeInstaller("3.0.1") });
  assert.deepEqual(readLock(lockFile).packages, { "is-odd@^3": "3.0.1" });
});

test("the install runner gets the JSR environment (#39)", (t) => {
  const dir = scratch(t);
  useCache(t, dir);
  const envs: (Record<string, string> | undefined)[] = [];
  const fake = fakeInstaller("1.0.10");
  const run: InstallRunner = (cmd, args, cwd, env) => {
    envs.push(env);
    return fake(cmd, args, cwd, env);
  };
  ensureInstalled({ name: "@jsr/std__fmt", range: "1" }, "npm", { run });
  ensureInstalled({ name: "is-odd", range: "3" }, "npm", { run });
  assert.deepEqual(envs, [{ npm_config_allow_remote: "root" }, undefined]);
});

test("a locked request installs its exact version: the same on every machine", (t) => {
  const dir = scratch(t);
  useCache(t, dir);
  const lockFile = join(dir, LOCK_FILE);
  writeLock(lockFile, { version: 1, packages: { "is-odd@^3": "3.0.0" } });
  const calls: string[] = [];
  // A newer 3.x exists, but the lock says 3.0.0.
  const { alias } = ensureInstalled({ name: "is-odd", range: "^3" }, "npm", { lockFile, run: fakeInstaller("3.9.9", calls) });
  assert.equal(alias, aliasFor("is-odd", "3.0.0"));
  assert.deepEqual(calls, [`${aliasFor("is-odd", "3.0.0")}@npm:is-odd@3.0.0`]);
  assert.deepEqual(readLock(lockFile).packages, { "is-odd@^3": "3.0.0" }, "unchanged");
});

test("a failed install throws, releases the lock and records nothing", (t) => {
  const dir = scratch(t);
  const cache = useCache(t, dir);
  const lockFile = join(dir, LOCK_FILE);
  writeFileSync(lockFile, "{}");
  const failing: InstallRunner = () => ({ status: 1, stderr: "E404 not found" });
  assert.throws(() => ensureInstalled({ name: "nope", range: "1" }, "npm", { lockFile, run: failing }), /npm install nope@1 failed:\nE404/);
  assert.deepEqual(readLock(lockFile).packages, {});
  assert.ok(!existsSync(join(cache, ".install-lock")));
});

test("withInstallLock takes over a lock whose holder has died", (t) => {
  const dir = scratch(t);
  const lockDir = join(dir, ".install-lock");
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, "pid"), "999999999");
  const old = new Date(Date.now() - 5000);
  utimesSync(lockDir, old, old);
  assert.equal(withInstallLock(dir, () => "ran"), "ran");
  assert.ok(!existsSync(lockDir));
});

test("withInstallLock waits for a live holder, then times out", (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, ".install-lock"));
  writeFileSync(join(dir, ".install-lock", "pid"), String(process.pid));
  const started = Date.now();
  assert.throws(() => withInstallLock(dir, () => "never", { timeoutMs: 400 }), /timed out waiting for the install lock/);
  assert.ok(Date.now() - started >= 400);
});

test("withInstallLock waits for a live holder however old its lock (#144)", (t) => {
  const dir = scratch(t);
  const lockDir = join(dir, ".install-lock");
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, "pid"), String(process.pid));
  // Older than the 10-minute wait, as a long install's lock would be.
  const old = new Date(Date.now() - 15 * 60 * 1000);
  utimesSync(lockDir, old, old);
  assert.throws(() => withInstallLock(dir, () => "never", { timeoutMs: 300 }), /timed out waiting for the install lock/);
  assert.equal(readFileSync(join(lockDir, "pid"), "utf8"), String(process.pid));
});

test("withInstallLock leaves a lock another process took over", (t) => {
  const dir = scratch(t);
  const lockDir = join(dir, ".install-lock");
  withInstallLock(dir, () => writeFileSync(join(lockDir, "pid"), "1"));
  assert.ok(existsSync(lockDir), "the new holder's lock is still there");
});

test("writeLock replaces the file in one step; a corrupt lockfile names itself", (t) => {
  const dir = scratch(t);
  const path = join(dir, LOCK_FILE);
  writeLock(path, { version: 1, packages: { "is-odd@^3": "3.0.1" } });
  assert.deepEqual(readdirSync(dir), [LOCK_FILE], "no temporary file left behind");
  writeFileSync(path, '{"version": 1, "packages": {"is-odd@^3": "3.0');
  assert.throws(() => readLock(path), (err: Error) => err.message.startsWith(`cannot read ${path}: `));
});

test("two kernels installing at once don't overlap, and install once", async (t) => {
  const dir = scratch(t);
  const cache = join(dir, "cache");
  const log = join(dir, "install.log");
  const hooks = new URL("../runtime/node-hooks.mjs", import.meta.url).href;
  // Each child is a kernel resolving npm:is-odd@^3 with a slow fake npm that
  // logs when it starts and ends.
  const child = `
    import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const { ensureInstalled } = await import(${JSON.stringify(hooks)});
    const run = (cmd, args, cwd) => {
      appendFileSync(${JSON.stringify(log)}, "start " + process.pid + "\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
      const alias = args[args.length - 1].split("@npm:")[0];
      mkdirSync(join(cwd, "node_modules", alias), { recursive: true });
      writeFileSync(join(cwd, "node_modules", alias, "package.json"), '{"version":"3.0.1"}');
      appendFileSync(${JSON.stringify(log)}, "end " + process.pid + "\\n");
      return { status: 0 };
    };
    console.log(ensureInstalled({ name: "is-odd", range: "^3" }, "npm", { run }).alias);
  `;
  const runChild = () =>
    new Promise<string>((resolve, reject) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", child], { env: { ...process.env, CDPK_CACHE_DIR: cache } });
      let out = "";
      p.stdout.on("data", (d: Buffer) => (out += d));
      p.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`child exited ${code}`))));
    });
  const [a, b] = await Promise.all([runChild(), runChild()]);
  assert.equal(a, b, "both resolve to the same install");
  const lines = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines.length, 2, `one install, not two: ${lines.join(", ")}`);
  assert.match(lines[0], /^start /);
  assert.match(lines[1], /^end /);
});
