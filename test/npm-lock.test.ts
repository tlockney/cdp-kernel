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
  ensureInstalledAsync,
  findLockFile,
  type InstallRunner,
  LOCK_FILE,
  readLock,
  withInstallLock,
  withInstallLockAsync,
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
  assert.throws(() => withInstallLock(dir, () => "never", { timeoutMs: 400 }), /timed out waiting for the lock/);
  assert.ok(Date.now() - started >= 400);
});

/** Counts event-loop turns while `work` runs: zero means it blocked. */
async function ticksDuring<T>(work: () => Promise<T>): Promise<{ value: T; ticks: number }> {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    return { value: await work(), ticks };
  } finally {
    clearInterval(timer);
  }
}

test("ensureInstalledAsync installs once, records the lock and leaves the event loop free (#149)", async (t) => {
  const dir = scratch(t);
  const cache = useCache(t, dir);
  const lockFile = join(dir, LOCK_FILE);
  writeFileSync(lockFile, "{}");
  const calls: string[] = [];
  const fake = fakeInstaller("3.0.1", calls);
  // A slow npm, answering after 200 ms.
  const run = (...args: Parameters<InstallRunner>) =>
    new Promise<ReturnType<InstallRunner>>((resolve) => setTimeout(() => resolve(fake(...args)), 200));
  const { value, ticks } = await ticksDuring(() => ensureInstalledAsync({ name: "is-odd", range: "^3" }, "npm", { lockFile, run }));
  assert.deepEqual(value, { dir: cache, alias: aliasFor("is-odd", "^3") });
  assert.ok(ticks >= 5, `timers ran during the install: ${ticks}`);
  await ensureInstalledAsync({ name: "is-odd", range: "^3" }, "npm", { run });
  assert.equal(calls.length, 1, "the second request reuses the install");
  assert.deepEqual(readLock(lockFile).packages, { "is-odd@^3": "3.0.1" });
  assert.ok(!existsSync(join(cache, ".install-lock")));
});

test("ensureInstalledAsync rejects a failed install and releases the lock", async (t) => {
  const dir = scratch(t);
  const cache = useCache(t, dir);
  const failing: InstallRunner = () => ({ status: 1, stderr: "E404 not found" });
  await assert.rejects(ensureInstalledAsync({ name: "nope", range: "1" }, "npm", { run: failing }), /npm install nope@1 failed:\nE404/);
  assert.ok(!existsSync(join(cache, ".install-lock")));
});

test("withInstallLockAsync waits for a live holder without blocking, then times out", async (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, ".install-lock"));
  writeFileSync(join(dir, ".install-lock", "pid"), String(process.pid));
  const { value, ticks } = await ticksDuring(() =>
    withInstallLockAsync(dir, () => "never", { timeoutMs: 400 }).then(() => null, (err: Error) => err)
  );
  assert.match(String(value), /timed out waiting for the lock/);
  assert.ok(ticks >= 10, `timers ran while waiting: ${ticks}`);
});

test("withInstallLock waits for a live holder however old its lock (#144)", (t) => {
  const dir = scratch(t);
  const lockDir = join(dir, ".install-lock");
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, "pid"), String(process.pid));
  // Older than the 10-minute wait, as a long install's lock would be.
  const old = new Date(Date.now() - 15 * 60 * 1000);
  utimesSync(lockDir, old, old);
  assert.throws(() => withInstallLock(dir, () => "never", { timeoutMs: 300 }), /timed out waiting for the lock/);
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

/** XDG_CACHE_HOME for this test, where Bun's cache is (npm's is CDPK_CACHE_DIR). */
function useXdgCache(t: { after(fn: () => void): void }, dir: string): void {
  const before = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = join(dir, "xdg");
  t.after(() => {
    if (before === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = before;
  });
}

test("concurrent npm and bun installs both land in the lockfile (#537)", async (t) => {
  const dir = scratch(t);
  useCache(t, dir);
  useXdgCache(t, dir);
  const lockFile = join(dir, LOCK_FILE);
  writeFileSync(lockFile, "{}\n");
  // Each runner waits until both installs have read the lockfile (they read
  // it before running), so both hold the empty lock when either finishes.
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => (release = resolve));
  const fake = fakeInstaller("3.0.1");
  const run = async (cmd: string, args: string[], cwd: string, env?: Record<string, string>) => {
    if (++arrived === 2) release();
    await barrier;
    return fake(cmd, args, cwd, env);
  };
  await Promise.all([
    ensureInstalledAsync({ name: "is-odd", range: "^3" }, "npm", { lockFile, run }),
    ensureInstalledAsync({ name: "is-even", range: "^1" }, "bun", { lockFile, run }),
  ]);
  assert.deepEqual(readLock(lockFile).packages, { "is-even@^1": "3.0.1", "is-odd@^3": "3.0.1" });
});

/** Holds the lock beside `lockFile` as a live process (this one) would. */
function holdLockfileLock(lockFile: string): string {
  const lockDir = `${lockFile}.lock`;
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, "pid"), String(process.pid));
  return lockDir;
}

test("recording waits for the lockfile lock, then merges what changed meanwhile (#537)", async (t) => {
  const dir = scratch(t);
  useCache(t, dir);
  const lockFile = join(dir, LOCK_FILE);
  writeFileSync(lockFile, "{}\n");
  const lockDir = holdLockfileLock(lockFile);
  let done = false;
  const install = ensureInstalledAsync({ name: "is-odd", range: "^3" }, "npm", { lockFile, run: fakeInstaller("3.0.1") }).then(() => (done = true));
  // Past the 100 ms retry, the install has finished and is waiting on the lock.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(!done, "recording waits while the lockfile lock is held");
  assert.deepEqual(readLock(lockFile).packages, {});
  // The holder writes its own entry, as another install would, then releases.
  writeLock(lockFile, { version: 1, packages: { "is-even@^1": "1.0.0" } });
  rmSync(lockDir, { recursive: true });
  await install;
  assert.deepEqual(readLock(lockFile).packages, { "is-even@^1": "1.0.0", "is-odd@^3": "3.0.1" });
  assert.ok(!existsSync(lockDir), "the lock is released");
});

test("ensureInstalled re-reads the lockfile when it records, after the lockfile lock is free (#537)", (t) => {
  const dir = scratch(t);
  useCache(t, dir);
  const lockFile = join(dir, LOCK_FILE);
  writeFileSync(lockFile, "{}\n");
  const lockDir = holdLockfileLock(lockFile);
  // ensureInstalled blocks, so the other install acts from inside the runner,
  // after this one read the lockfile and before it records.
  const run: InstallRunner = (cmd, args, cwd, env) => {
    const result = fakeInstaller("3.0.1")(cmd, args, cwd, env);
    // Another install records its entry meanwhile, then lets go of the lock.
    writeLock(lockFile, { version: 1, packages: { "is-even@^1": "1.0.0" } });
    rmSync(lockDir, { recursive: true });
    return result;
  };
  ensureInstalled({ name: "is-odd", range: "^3" }, "npm", { lockFile, run });
  assert.deepEqual(readLock(lockFile).packages, { "is-even@^1": "1.0.0", "is-odd@^3": "3.0.1" });
  assert.ok(!existsSync(lockDir), "the lock is released");
});

test("recording takes over a lockfile lock whose holder has died (#537)", (t) => {
  const dir = scratch(t);
  useCache(t, dir);
  const lockFile = join(dir, LOCK_FILE);
  writeFileSync(lockFile, "{}\n");
  const lockDir = `${lockFile}.lock`;
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, "pid"), "999999999");
  const old = new Date(Date.now() - 5000);
  utimesSync(lockDir, old, old);
  ensureInstalled({ name: "is-odd", range: "^3" }, "npm", { lockFile, run: fakeInstaller("3.0.1") });
  assert.deepEqual(readLock(lockFile).packages, { "is-odd@^3": "3.0.1" });
  assert.ok(!existsSync(lockDir));
});
