// @ts-self-types="./node-hooks.d.mts"
// Node-only module resolution for cell code: the part of Deno's module
// loader a notebook leans on most.
//   - Imports issued by cell code arrive with the bootstrap module as their
//     parent; re-parent them to the notebook's directory so "./x.ts" and
//     bare package names resolve where the user expects.
//   - npm:<name>[@range][/subpath] installs on first use into a per-user
//     cache, each request under its own npm alias so different ranges of
//     one package can coexist (Deno keeps a global cache the same way).
//   - jsr:@scope/name[@range][/subpath] maps onto JSR's npm compatibility
//     registry (npm.jsr.io) as @jsr/scope__name.
// Uses module.registerHooks (synchronous, in-thread; Node >= 23.5), so the
// install can run with spawnSync inside resolve.

// Not a named import: Bun, which loads this file for its npm:/jsr: helpers,
// has no registerHooks, and a missing named export fails at link time.
import module from "node:module";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SPEC_RE = /^((?:@[^/@]+\/)?[^/@]+)(?:@([^/]+))?(\/.*)?$/;

/** Splits "name@range/sub/path" (name may be scoped). */
export function parsePackageSpecifier(spec) {
  const m = SPEC_RE.exec(spec);
  if (!m) throw new TypeError(`invalid package specifier: ${spec}`);
  return { name: m[1], range: m[2] ?? "*", subpath: m[3] ?? "" };
}

/** jsr:@std/path@^1/posix -> npm @jsr/std__path@^1 /posix */
export function jsrToNpm(spec) {
  const { name, range, subpath } = parsePackageSpecifier(spec);
  const m = /^@([^/]+)\/(.+)$/.exec(name);
  if (!m) throw new TypeError(`jsr packages are scoped: jsr:${spec}`);
  return { name: `@jsr/${m[1]}__${m[2]}`, range, subpath };
}

export function aliasFor(name, range) {
  const digest = createHash("sha256").update(`${name}@${range}`).digest("hex").slice(0, 12);
  return `cdpk-${digest}`;
}

// Each installer keeps its own cache, so npm's and Bun's lockfiles never
// meet; both read the @jsr registry from .npmrc.
function cacheDir(installer) {
  const dir = installer === "npm"
    ? process.env.CDPK_CACHE_DIR ?? join(homedir(), ".cache", "cdp-kernel", "npm")
    : join(homedir(), ".cache", "cdp-kernel", installer);
  if (!existsSync(join(dir, "package.json"))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), '{ "private": true }\n');
    writeFileSync(join(dir, ".npmrc"), "@jsr:registry=https://npm.jsr.io\n");
  }
  return dir;
}

/** The command that installs name@range under `alias` with `installer`. */
export function installCommand(installer, alias, name, range) {
  const spec = `${alias}@npm:${name}@${range}`;
  // The Bun target runs this inside Bun, so it uses its own binary.
  if (installer === "bun") return { cmd: process.execPath, args: ["add", "--silent", spec] };
  return { cmd: "npm", args: ["install", "--no-audit", "--no-fund", "--loglevel=error", spec] };
}

// --- Lockfile (#14) -----------------------------------------------------------
// A cdp-kernel.lock.json at or above the notebook pins each npm:/jsr:
// request to the exact version it first resolved to, so the same notebook
// gets the same packages on another machine. Opt-in: create the file (with
// `{}` in it) to start locking; the kernel then fills it in.

export const LOCK_FILE = "cdp-kernel.lock.json";

/** The nearest cdp-kernel.lock.json at or above `dir`, or null. */
export function findLockFile(dir) {
  for (let at = dir;; at = dirname(at)) {
    if (existsSync(join(at, LOCK_FILE))) return join(at, LOCK_FILE);
    if (dirname(at) === at) return null;
  }
}

/** `{ version: 1, packages: { "name@range": "exact version" } }`; `{}` counts as empty. */
export function readLock(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8") || "{}");
  const packages = parsed && typeof parsed.packages === "object" && parsed.packages !== null ? parsed.packages : {};
  return { version: 1, packages };
}

/** Sorted, so a lockfile's diff shows only what changed. */
export function writeLock(path, lock) {
  const packages = Object.fromEntries(Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, JSON.stringify({ version: 1, packages }, null, 2) + "\n");
}

// --- Serialized installs (#14) -------------------------------------------------
// Kernels share one cache per installer, and npm/bun both rewrite its
// package.json and node_modules, so installs take a lock: a directory, which
// mkdir creates atomically. A lock left by a process that died is taken over.

const LOCK_DIR = ".install-lock";
const STALE_MS = 10 * 60 * 1000;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function holderAlive(lockDir) {
  try {
    const pid = Number(readFileSync(join(lockDir, "pid"), "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive, but someone else's.
    return err?.code === "EPERM";
  }
}

/** Runs `fn` holding the cache's install lock. Synchronous, like the resolve hook. */
export function withInstallLock(dir, fn, { timeoutMs = STALE_MS } = {}) {
  const lockDir = join(dir, LOCK_DIR);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "pid"), String(process.pid));
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      let age = 0;
      try {
        age = Date.now() - statSync(lockDir).mtimeMs;
      } catch {
        continue; // released meanwhile
      }
      // A holder that died, or one stuck for longer than any install takes.
      if ((age > 1000 && !holderAlive(lockDir)) || age > STALE_MS) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for the install lock ${lockDir}`);
      sleep(100);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function installedVersion(dir, alias) {
  try {
    return JSON.parse(readFileSync(join(dir, "node_modules", alias, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

function spawnInstall(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8" });
}

/**
 * Installs a package into the installer's cache unless it's there already.
 * With a lockfile, a locked request installs its exact version, and an
 * unlocked one is recorded once installed. `run` is the install command
 * runner, replaceable in tests.
 */
export function ensureInstalled({ name, range }, installer = "npm", { lockFile = null, run = spawnInstall } = {}) {
  const dir = cacheDir(installer);
  const key = `${name}@${range}`;
  return withInstallLock(dir, () => {
    const lock = lockFile ? readLock(lockFile) : null;
    const locked = lock?.packages[key];
    const version = typeof locked === "string" ? locked : range;
    const alias = aliasFor(name, version);
    if (installedVersion(dir, alias) === null) {
      const { cmd, args } = installCommand(installer, alias, name, version);
      const result = run(cmd, args, dir);
      if (result.status !== 0) {
        throw new Error(`${installer} install ${name}@${version} failed:\n${result.stderr || result.error}`);
      }
    }
    if (lock && typeof locked !== "string") {
      const resolved = installedVersion(dir, alias);
      if (resolved !== null) {
        lock.packages[key] = resolved;
        writeLock(lockFile, lock);
      }
    }
    return { dir, alias };
  });
}

export function installNodeResolveHooks({ shimUrl, replUrl }) {
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      let pkg = null;
      if (specifier.startsWith("npm:")) pkg = parsePackageSpecifier(specifier.slice(4));
      else if (specifier.startsWith("jsr:")) pkg = jsrToNpm(specifier.slice(4));
      if (pkg) {
        const lockFile = findLockFile(fileURLToPath(new URL(".", replUrl)));
        const { dir, alias } = ensureInstalled(pkg, "npm", { lockFile });
        const parentURL = pathToFileURL(join(dir, "package.json")).href;
        return nextResolve(alias + pkg.subpath, { ...context, parentURL });
      }
      if (context.parentURL === shimUrl) {
        return nextResolve(specifier, { ...context, parentURL: replUrl });
      }
      return nextResolve(specifier, context);
    },
  });
}
