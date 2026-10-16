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
//   - TypeScript files a cell imports load with Node's own type stripping
//     where it can; syntax that needs code generation (enum, namespaces with
//     values, parameter properties) is compiled by esbuild instead (#73).
//     Node can't load JSX at all, so .tsx/.jsx files are always compiled (#91).
// Uses module.registerHooks (synchronous, in-thread; Node >= 23.5), so the
// install can run with spawnSync inside resolve.

// Not a named import: Bun, which loads this file for its npm:/jsr: helpers,
// has no registerHooks, and a missing named export fails at link time.
import module from "node:module";
import { spawn, spawnSync } from "node:child_process";
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

/**
 * Each installer keeps its own cache, so npm's and Bun's lockfiles never
 * meet. Both sit beside the runtime cache (cacheRoot in src/package.ts);
 * CDPK_CACHE_DIR overrides npm's.
 */
export function cacheDirPath(installer, env = process.env, home = homedir()) {
  if (installer === "npm" && env.CDPK_CACHE_DIR) return env.CDPK_CACHE_DIR;
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "cdp-kernel", installer);
}

// Both caches read the @jsr registry from .npmrc.
function cacheDir(installer) {
  const dir = cacheDirPath(installer);
  if (!existsSync(join(dir, "package.json"))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), '{ "private": true }\n');
    writeFileSync(join(dir, ".npmrc"), "@jsr:registry=https://npm.jsr.io\n");
  }
  return dir;
}

/** The command that installs name@range under `alias` with `installer`. */
//   - Saved exactly (#40): npm records `npm:react@19.0.0` as `^19.0.0` by
//     default, and every later install into the shared cache re-resolves the
//     ranges, so pinned packages drifted (react 19.3.1 beside react-dom
//     19.0.0). With an exact save, a version stays put and a range is frozen
//     at what it first resolved to. Bun already saves exactly; the flag says so.
//   - JSR packages come as tarballs from npm.jsr.io, which npm 12 refuses as
//     "remote" unless allowed (#39). `root` is the narrowest value that works
//     (`true`, which looks right, is invalid and warns), and only the JSR
//     install gets it.
export function installCommand(installer, alias, name, range) {
  const spec = `${alias}@npm:${name}@${range}`;
  // The Bun target runs this inside Bun, so it uses its own binary.
  if (installer === "bun") return { cmd: process.execPath, args: ["add", "--silent", "--exact", spec] };
  const args = ["install", "--no-audit", "--no-fund", "--loglevel=error", "--save-exact", spec];
  return name.startsWith("@jsr/") ? { cmd: "npm", args, env: { npm_config_allow_remote: "root" } } : { cmd: "npm", args };
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

/** Takes the install lock at `lockDir` if it's free: false means wait and try again. */
function tryLock(lockDir, deadline) {
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "pid"), String(process.pid));
      return true;
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
      return false;
    }
  }
}

/** Runs `fn` holding the cache's install lock. Synchronous, like the resolve hook. */
export function withInstallLock(dir, fn, { timeoutMs = STALE_MS } = {}) {
  const lockDir = join(dir, LOCK_DIR);
  const deadline = Date.now() + timeoutMs;
  while (!tryLock(lockDir, deadline)) sleep(100);
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/** withInstallLock for a caller that mustn't block its event loop while it waits. */
export async function withInstallLockAsync(dir, fn, { timeoutMs = STALE_MS } = {}) {
  const lockDir = join(dir, LOCK_DIR);
  const deadline = Date.now() + timeoutMs;
  while (!tryLock(lockDir, deadline)) await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    return await fn();
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

/**
 * How to spawn an install command on `platform`. On Windows npm is npm.cmd,
 * which Node runs only through a shell (#51). cmd.exe reads ^ < > | & as
 * operators, and semver ranges use them, so each argument is double-quoted,
 * where cmd.exe leaves them alone. A " or % would still be read, so they're
 * refused; no package name or valid range contains either.
 */
export function spawnCommand(cmd, args, platform = process.platform) {
  if (platform !== "win32" || cmd !== "npm") return { cmd, args, shell: false };
  const bad = args.find((arg) => /["%\r\n]/.test(arg));
  if (bad !== undefined) throw new TypeError(`can't pass ${JSON.stringify(bad)} to npm through cmd.exe`);
  return { cmd, args: args.map((arg) => `"${arg}"`), shell: true };
}

function spawnInstall(cmd, args, cwd, env = {}) {
  const spawned = spawnCommand(cmd, args);
  return spawnSync(spawned.cmd, spawned.args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, shell: spawned.shell });
}

/** spawnInstall without blocking: the kernel host keeps answering while it runs (#149). */
function spawnInstallAsync(cmd, args, cwd, env = {}) {
  const spawned = spawnCommand(cmd, args);
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn(spawned.cmd, spawned.args, {
      cwd,
      env: { ...process.env, ...env },
      shell: spawned.shell,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ status: null, stderr, error }));
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

/** The version to install for `name@range`: the locked one, if the lockfile has it. */
function lockedRequest(name, range, lockFile) {
  const lock = lockFile ? readLock(lockFile) : null;
  const locked = lock?.packages[`${name}@${range}`];
  const version = typeof locked === "string" ? locked : range;
  return { lock, locked: typeof locked === "string", version, alias: aliasFor(name, version) };
}

/** Records an unlocked request's installed version in the lockfile. */
function recordLock(dir, name, range, lockFile, { lock, locked, alias }) {
  if (!lock || locked) return;
  const resolved = installedVersion(dir, alias);
  if (resolved !== null) {
    lock.packages[`${name}@${range}`] = resolved;
    writeLock(lockFile, lock);
  }
}

function checkInstall(result, installer, name, version) {
  if (result.status !== 0) throw new Error(`${installer} install ${name}@${version} failed:\n${result.stderr || result.error}`);
}

/**
 * Installs a package into the installer's cache unless it's there already.
 * With a lockfile, a locked request installs its exact version, and an
 * unlocked one is recorded once installed. `run` is the install command
 * runner, replaceable in tests.
 */
export function ensureInstalled({ name, range }, installer = "npm", { lockFile = null, run = spawnInstall } = {}) {
  const dir = cacheDir(installer);
  return withInstallLock(dir, () => {
    const request = lockedRequest(name, range, lockFile);
    if (installedVersion(dir, request.alias) === null) {
      const { cmd, args, env } = installCommand(installer, request.alias, name, request.version);
      checkInstall(run(cmd, args, dir, env), installer, name, request.version);
    }
    recordLock(dir, name, range, lockFile, request);
    return { dir, alias: request.alias };
  });
}

/** ensureInstalled for the kernel host (workerd's bundler), which mustn't block (#149). */
export function ensureInstalledAsync({ name, range }, installer = "npm", { lockFile = null, run = spawnInstallAsync } = {}) {
  const dir = cacheDir(installer);
  return withInstallLockAsync(dir, async () => {
    const request = lockedRequest(name, range, lockFile);
    if (installedVersion(dir, request.alias) === null) {
      const { cmd, args, env } = installCommand(installer, request.alias, name, request.version);
      checkInstall(await run(cmd, args, dir, env), installer, name, request.version);
    }
    recordLock(dir, name, range, lockFile, request);
    return { dir, alias: request.alias };
  });
}

// --- Imported TypeScript (#73) --------------------------------------------------
// Node strips types in place, so line and column numbers stay those of the
// file, but it rejects TypeScript that needs code generation. Such a file
// is compiled with esbuild, as cells are, with an inline source map. The
// host passes its esbuild binary in CDPK_ESBUILD_BINARY: the runtime files
// may have been copied away from any node_modules (src/package.ts), and the
// esbuild binary, unlike its JavaScript API, works from anywhere.

// Both match a file: URL's path, so a query or fragment (`./x.ts?v=2`, the
// cache-busting idiom for a module being edited) doesn't hide the extension (#145).
const TS_FILE = /\.[cm]?ts$/;
// Node has no format for these extensions, so its loader is never asked.
const JSX_FILE = /\.([jt]sx)$/;
const TS_FORMATS = { "module-typescript": "module", "commonjs-typescript": "commonjs" };

function isUnsupportedSyntax(err) {
  return err?.code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX";
}

/** Node's strip-only transform, without its once-per-process ExperimentalWarning. */
function stripTypes(source) {
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    if (String(warning?.message ?? warning).includes("stripTypeScriptTypes")) return;
    return emitWarning.call(this, warning, ...rest);
  };
  try {
    return module.stripTypeScriptTypes(source, { mode: "strip" });
  } finally {
    process.emitWarning = emitWarning;
  }
}

/**
 * Compiles one TypeScript (or, with loader "tsx"/"jsx", JSX) file with the
 * esbuild binary at `binary`, as cells are compiled. JSX takes esbuild's
 * default, classic React.createElement, which is what cells use on Node
 * (no project config there); a file's own @jsx/@jsxImportSource pragma wins.
 */
export function compileTypeScript(source, filename, binary, run = spawnSync, loader = "ts") {
  const args = [
    `--loader=${loader}`,
    "--target=esnext",
    "--sourcemap=inline",
    `--sourcefile=${filename}`,
    '--tsconfig-raw={"compilerOptions":{"verbatimModuleSyntax":true}}',
    "--log-level=error",
    "--color=false",
  ];
  const result = run(binary, args, { input: source, encoding: "utf8", maxBuffer: 1 << 30 });
  if (result.status !== 0) {
    throw new SyntaxError(`${filename}: ${(result.stderr || String(result.error)).trim()}`);
  }
  return result.stdout;
}

/** The load hook: Node's result unless it would reject the file's TypeScript. */
export function loadTypeScript(url, context, nextLoad, binary) {
  const path = url.startsWith("file:") ? new URL(url).pathname : "";
  const jsx = JSX_FILE.exec(path);
  if (binary && jsx) {
    // Notebooks import ES modules, so it's compiled as one.
    const filename = fileURLToPath(url);
    const source = compileTypeScript(readFileSync(filename, "utf8"), filename, binary, spawnSync, jsx[1]);
    return { format: "module", source, shortCircuit: true };
  }
  if (!binary || !TS_FILE.test(path)) return nextLoad(url, context);
  let result;
  try {
    result = nextLoad(url, context);
  } catch (err) {
    // A .ts file outside a package.json "type" is stripped while Node
    // detects its format, so the rejection surfaces here. Notebooks import
    // ES modules, so it's compiled as one.
    if (!isUnsupportedSyntax(err)) throw err;
    const filename = fileURLToPath(url);
    return { format: "module", source: compileTypeScript(readFileSync(filename, "utf8"), filename, binary), shortCircuit: true };
  }
  const format = TS_FORMATS[result.format];
  if (format === undefined || typeof module.stripTypeScriptTypes !== "function") return result;
  const source = typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
  try {
    return { ...result, format, source: stripTypes(source) };
  } catch (err) {
    if (!isUnsupportedSyntax(err)) throw err;
    return { ...result, format, source: compileTypeScript(source, fileURLToPath(url), binary) };
  }
}

export function installNodeResolveHooks({ shimUrl, replUrl }) {
  const esbuild = process.env.CDPK_ESBUILD_BINARY;
  module.registerHooks({
    load: (url, context, nextLoad) => loadTypeScript(url, context, nextLoad, esbuild),
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
