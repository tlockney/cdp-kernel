// What `cdp-kernel install` writes into a kernelspec so it outlives the Node
// that ran it (#508).
//
// With a version manager (mise, asdf, volta, fnm, nvm, Homebrew) both the
// `node` binary and the npm global directory holding dist/main.js live in a
// per-version directory, so removing or upgrading that Node broke every
// kernelspec. Two fixes:
//   - stableExecPath: name the version manager's shim or stable link
//     instead of the versioned binary, where it has one.
//   - stablePackage: copy the installed package, with the dependencies it
//     resolves at run time, to <jupyter data dir>/cdp-kernel/<version>/.

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { isInsideNodeModules, type Origin } from "./package.ts";

const PACKAGE_NAME = "@tlockney/cdp-kernel";

/** Jupyter's data directory; kernelspecs live in its `kernels/` directory. */
export function jupyterDataDir(
  env: Record<string, string | undefined> = process.env,
  platform: string = osPlatform(),
  home: string = homedir(),
): string {
  // Absolute, because the kernelspec's argv outlives this process's cwd.
  if (env.JUPYTER_DATA_DIR) return resolve(env.JUPYTER_DATA_DIR);
  if (platform === "win32") return resolve(env.APPDATA ?? home, "jupyter");
  if (platform === "darwin") return join(home, "Library", "Jupyter");
  return resolve(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "jupyter");
}

/** Where stable copies of the package go. */
export function stableRoot(dataDir: string): string {
  return join(dataDir, "cdp-kernel");
}

export interface ExecPathOptions {
  exists?: (path: string) => boolean;
  platform?: string;
  env?: Record<string, string | undefined>;
  /** Keep `execPath` exactly (`install --pin`). */
  pin?: boolean;
}

function under(path: string, prefix: string | undefined, sub: string): boolean {
  return prefix !== undefined && prefix !== "" && path.startsWith(prefix.replace(/\/+$/, "") + sub);
}

/**
 * A path to the same program that stays valid when the version manager
 * removes or replaces this version, or `execPath` itself when it already is.
 * The result is a shim or link when the manager has one (for the managers
 * that choose the version from the notebook's directory, that is the
 * point). A missing shim keeps `execPath`. nvm and n have no
 * stable path, so their binary is kept.
 */
export function stableExecPath(execPath: string, options: ExecPathOptions = {}): string {
  const { exists = existsSync, platform = process.platform, env = process.env, pin = false } = options;
  if (pin || platform === "win32") return execPath;
  const segs = execPath.split("/");
  const name = segs[segs.length - 1];
  if (!name) return execPath;
  const shimOr = (candidate: string) => (exists(candidate) ? candidate : execPath);
  // `<root>/<dir>/…` where segs[i] is `dir`: the part before it.
  const rootBefore = (i: number) => segs.slice(0, i).join("/");

  // mise and asdf: <root>/installs/<tool>/<version>/…, shims in <root>/shims.
  for (let i = 1; i < segs.length - 3; i++) {
    if (segs[i] !== "installs") continue;
    const root = rootBefore(i);
    const manager = segs[i - 1] === "mise" || under(execPath, env.MISE_DATA_DIR, "/installs/") ||
      segs[i - 1] === ".asdf" || under(execPath, env.ASDF_DATA_DIR, "/installs/");
    if (manager) return shimOr(`${root}/shims/${name}`);
  }
  // volta: <root>/tools/image/<tool>/<version>/…, launchers in <root>/bin.
  for (let i = 1; i < segs.length - 4; i++) {
    if (segs[i] !== "tools" || segs[i + 1] !== "image") continue;
    const root = rootBefore(i);
    if (segs[i - 1] === ".volta" || segs[i - 1] === "volta" || under(execPath, env.VOLTA_HOME, "/tools/image/")) {
      return shimOr(`${root}/bin/${name}`);
    }
  }
  // Homebrew: <prefix>/Cellar/<formula>/<version>/bin/<name>. <prefix>/opt/<formula>
  // follows the formula's current version, and exists for keg-only ones
  // (node@22) that <prefix>/bin doesn't link.
  const cellar = segs.length - 5;
  if (cellar >= 1 && segs[cellar] === "Cellar" && segs[segs.length - 2] === "bin") {
    return shimOr(`${rootBefore(cellar)}/opt/${segs[cellar + 1]}/bin/${name}`);
  }
  // fnm has no shims, but <root>/aliases/default follows `fnm default`.
  const fnm = fnmRoot(execPath, env, platform);
  if (fnm !== undefined) {
    const alias = `${fnm}/aliases/default/bin/${name}`;
    return exists(alias) ? alias : execPath;
  }
  // nvm and n have no stable path. A bare name would depend on the
  // launcher's PATH, which a GUI app's login shell often doesn't set up
  // (nvm's setup lives in .zshrc), so keep the exact binary; see
  // pinnedByManager.
  return execPath;
}

function fnmRoot(execPath: string, env: Record<string, string | undefined>, platform: string): string | undefined {
  const at = execPath.indexOf("/node-versions/");
  if (at > 0 && execPath.slice(0, at).split("/").some((s) => s === "fnm" || s === ".fnm")) return execPath.slice(0, at);
  if (env.FNM_DIR && execPath.startsWith(env.FNM_DIR.replace(/\/+$/, "") + "/node-versions/")) return env.FNM_DIR.replace(/\/+$/, "");
  if (!execPath.includes("/fnm_multishells/")) return undefined;
  if (env.FNM_DIR) return env.FNM_DIR.replace(/\/+$/, "");
  const home = env.HOME ?? homedir();
  return platform === "darwin" ? `${home}/Library/Application Support/fnm` : `${env.XDG_DATA_HOME ?? `${home}/.local/share`}/fnm`;
}

/**
 * The version manager whose binary `stableExecPath` had to keep as is
 * (it has no shim or stable link), for `install` to say so.
 */
export function pinnedByManager(execPath: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if (execPath.includes("/.nvm/versions/") || under(execPath, env.NVM_DIR, "/versions/")) return "nvm";
  if (execPath.includes("/n/versions/")) return "n";
  if (execPath.includes("/node-versions/") || execPath.includes("/fnm_multishells/")) return "fnm";
  return undefined;
}

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readPackageJson(dir: string): PackageJson | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
}

/** The directory holding this package's package.json above `file`. */
export function findPackageRoot(file: string): string | undefined {
  for (let dir = dirname(file);; dir = dirname(dir)) {
    if (readPackageJson(dir)?.name === PACKAGE_NAME) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Where Node finds `name` from `from`: the nearest enclosing node_modules
 * holding it, not looking above `ceiling` (default: the filesystem root).
 */
function lookup(from: string, name: string, ceiling?: string): string | undefined {
  for (let dir = from;; dir = dirname(dir)) {
    if (basename(dir) !== "node_modules") {
      const candidate = join(dir, "node_modules", ...name.split("/"));
      if (existsSync(join(candidate, "package.json"))) return candidate;
    }
    if (dir === ceiling || dirname(dir) === dir) return undefined;
  }
}

/** Every package directory below `root`: root itself and each node_modules entry, at any depth. */
function packagesIn(root: string): string[] {
  const found = [root];
  const visit = (pkg: string) => {
    const modules = join(pkg, "node_modules");
    let entries;
    try {
      entries = readdirSync(modules, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dirs = entry.name.startsWith("@")
        ? readdirSync(join(modules, entry.name), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => join(modules, entry.name, e.name))
        : [join(modules, entry.name)];
      for (const dir of dirs) {
        found.push(dir);
        visit(dir);
      }
    }
  };
  visit(root);
  return found;
}

/**
 * Replace every symlink below `dir` with a copy of its target, and drop
 * dangling ones and links to an ancestor. cpSync leaves some (node_modules/.bin
 * entries) pointing back into the source prefix.
 */
/** A symlink whose target is gone. */
function isDangling(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && !existsSync(path);
  } catch {
    return false;
  }
}

// Node 26's cpSync with `dereference` fails on a dangling symlink (an
// npm `.bin` entry whose package is missing, say), so leave those out.
const COPY_OPTIONS = { recursive: true, dereference: true, filter: (src: string) => !isDangling(src) };

function dereferenceTree(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (lstatSync(path).isSymbolicLink()) {
      let target: string | undefined;
      try {
        target = realpathSync(path);
      } catch { /* dangling */ }
      const here = realpathSync(dir);
      rmSync(path, { force: true });
      if (target === undefined || here === target || here.startsWith(target + sep)) continue;
      cpSync(target, path, COPY_OPTIONS);
    }
    if (lstatSync(path).isDirectory()) dereferenceTree(path);
  }
}

/** True when `dir` holds this version of the package and every non-optional dependency resolves inside it. */
function isComplete(dir: string, version: string, source?: string): boolean {
  const json = readPackageJson(dir);
  if (json?.name !== PACKAGE_NAME || json.version !== version) return false;
  try {
    for (const pkg of packagesIn(dir)) {
      const deps = readPackageJson(pkg);
      for (const name of Object.keys(deps?.dependencies ?? {})) {
        if (lookup(pkg, name, dir) === undefined) return false;
      }
      // An optional dependency (esbuild's platform package) missing from the
      // copy but installed in the source: the copy was made without it.
      if (source === undefined) continue;
      const sourcePkg = join(source, relative(dir, pkg));
      if (!existsSync(sourcePkg)) continue;
      for (const name of Object.keys(deps?.optionalDependencies ?? {})) {
        if (lookup(pkg, name, dir) === undefined && lookup(sourcePkg, name) !== undefined) return false;
      }
    }
  } catch {
    return false;
  }
  return true;
}

class Conflict extends Error {}

/**
 * Make every dependency of every package under `copy` resolve inside it, by
 * copying what the source resolves from outside (a hoisted or pnpm layout)
 * to `<copy>/node_modules/<name>`. `source` is the tree `copy` was copied
 * from. Throws Conflict when a name would have to resolve to two versions.
 */
function completeDependencies(copy: string, source: string): void {
  // Copied-in packages: where their files came from.
  const origins = new Map<string, string>([[copy, source]]);
  const sourceOf = (dir: string): string => {
    let best = copy;
    for (const root of origins.keys()) if ((dir === root || dir.startsWith(root + sep)) && root.length >= best.length) best = root;
    return join(origins.get(best)!, relative(best, dir));
  };
  const done = new Set<string>();
  for (let progress = true; progress;) {
    progress = false;
    for (const pkg of packagesIn(copy)) {
      if (done.has(pkg)) continue;
      done.add(pkg);
      const json = readPackageJson(pkg);
      if (!json) continue;
      const names = [...Object.keys(json.dependencies ?? {}), ...Object.keys(json.optionalDependencies ?? {})];
      for (const name of names) {
        const original = lookup(sourceOf(pkg), name);
        if (original === undefined) continue; // not installed: an optional dependency for another platform
        const found = lookup(pkg, name, copy);
        if (found !== undefined) {
          if (readPackageJson(found)?.version !== readPackageJson(original)?.version) {
            throw new Conflict(`${name} resolves to a different version from ${pkg} than in the original install`);
          }
          continue;
        }
        const real = realpathSync(original);
        const target = join(copy, "node_modules", ...name.split("/"));
        cpSync(real, target, COPY_OPTIONS);
        dereferenceTree(target);
        origins.set(join(copy, "node_modules", ...name.split("/")), real);
        progress = true;
      }
    }
  }
}

export interface StableCopy {
  /** The package's file to run, in the stable location. */
  entry: string;
  /** The stable package root. */
  dest: string;
  /** False when a complete copy of this version was already there and was kept. */
  copied: boolean;
}

/**
 * Copy the installed package containing `entry` (a file inside it) to
 * `<dataDir>/cdp-kernel/<version>/` with every dependency it needs, so the
 * kernelspec doesn't depend on the npm prefix of one Node version. A complete
 * copy of the same version is kept; an incomplete one is replaced. Returns
 * undefined, after saying why on `warn`, when the package can't be copied:
 * the caller then points at the original.
 */
export function stablePackage(
  entry: string,
  dataDir: string,
  version: string,
  warn: (message: string) => void = console.error,
): StableCopy | undefined {
  const dest = join(stableRoot(dataDir), version);
  let real: string;
  try {
    real = realpathSync(entry);
  } catch {
    real = resolve(entry);
  }
  const pkgRoot = findPackageRoot(real);
  if (pkgRoot === undefined) {
    warn(`install: can't find the ${PACKAGE_NAME} package above ${entry}; pointing the kernelspec at it`);
    return undefined;
  }
  const result = (copied: boolean): StableCopy => ({ entry: join(dest, relative(pkgRoot, real)), dest, copied });
  if (isComplete(dest, version, pkgRoot)) return result(false);
  const staging = `${dest}.${process.pid}.tmp`;
  const aside = `${dest}.old.${process.pid}`;
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(stableRoot(dataDir), { recursive: true });
    cpSync(pkgRoot, staging, COPY_OPTIONS);
    dereferenceTree(staging);
    completeDependencies(staging, pkgRoot);
    if (existsSync(dest)) renameSync(dest, aside);
    try {
      renameSync(staging, dest);
    } catch (err) {
      // Another install finished first; its copy is complete.
      if (!isComplete(dest, version)) throw err;
    }
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    if (!existsSync(dest) && existsSync(aside)) renameSync(aside, dest); // keep what was there
    warn(
      `install: couldn't copy the package to ${dest} (${err instanceof Error ? err.message : String(err)}); ` +
        `pointing the kernelspec at ${entry}`,
    );
    return undefined;
  } finally {
    rmSync(aside, { recursive: true, force: true });
  }
  rmSync(staging, { recursive: true, force: true });
  return result(true);
}

/**
 * The origin a kernelspec should run: the same, except that an npm install
 * (a file inside node_modules) is copied to a stable place first. `moduleUrl`
 * is the CLI's import.meta.url.
 */
export function stableOrigin(
  origin: Origin,
  moduleUrl: string,
  dataDir: string,
  version: string,
  warn: (message: string) => void = console.error,
): { origin: Origin; copy?: StableCopy } {
  if (origin.kind !== "file" || !isInsideNodeModules(moduleUrl)) return { origin };
  const copy = stablePackage(origin.path, dataDir, version, warn);
  return copy ? { origin: { kind: "file", path: copy.entry }, copy } : { origin };
}

const VERSION_DIR = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const LEFTOVER_DIR = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.(?:(\d+)\.tmp|old\.(\d+))$/;

function isRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove stable copies no kernelspec runs any more. `argvs` are the argv of
 * the cdp-kernel kernelspecs that remain. Only version-named directories
 * directly in `<dataDir>/cdp-kernel/` are candidates. Returns what it removed.
 */
export function pruneStableCopies(dataDir: string, argvs: string[][]): string[] {
  const root = stableRoot(dataDir);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const roots = [root];
  try {
    roots.push(realpathSync(root));
  } catch { /* gone between the two calls */ }
  const removed: string[] = [];
  for (const entry of entries) {
    // An install killed mid-copy leaves `<version>.<pid>.tmp` or
    // `<version>.old.<pid>`; remove those whose process is gone.
    const leftover = LEFTOVER_DIR.exec(entry.name);
    if (entry.isDirectory() && leftover && !isRunning(Number(leftover[1] ?? leftover[2]))) {
      rmSync(join(root, entry.name), { recursive: true, force: true });
      removed.push(join(root, entry.name));
      continue;
    }
    if (!entry.isDirectory() || !VERSION_DIR.test(entry.name)) continue;
    const prefixes = roots.map((r) => join(r, entry.name) + sep);
    const used = argvs.some((argv) => argv.some((arg) => isAbsolute(arg) && prefixes.some((p) => resolve(arg).startsWith(p))));
    if (used) continue;
    rmSync(join(root, entry.name), { recursive: true, force: true });
    removed.push(join(root, entry.name));
  }
  return removed;
}
