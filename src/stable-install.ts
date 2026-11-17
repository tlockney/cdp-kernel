// What `cdp-kernel install` writes into a kernelspec so it outlives the Node
// that ran it (#508).
//
// With a version manager (mise, asdf, volta, fnm, nvm, Homebrew) both the
// `node` binary and the npm global directory holding dist/main.js live in a
// per-version directory, so removing or upgrading that Node broke every
// kernelspec. Two fixes:
//   - stableExecPath: name the version manager's shim (or the bare program
//     name) instead of the versioned binary.
//   - stablePackage: copy the installed package, with the dependencies it
//     resolves at run time, to <jupyter data dir>/cdp-kernel/<version>/.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { isInsideNodeModules, type Origin } from "./package.ts";

const PACKAGE_NAME = "@tlockney/cdp-kernel";

/** Jupyter's data directory; kernelspecs live in its `kernels/` directory. */
export function jupyterDataDir(
  env: Record<string, string | undefined> = process.env,
  platform: string = osPlatform(),
  home: string = homedir(),
): string {
  if (env.JUPYTER_DATA_DIR) return env.JUPYTER_DATA_DIR;
  if (platform === "darwin") return join(home, "Library", "Jupyter");
  if (platform === "win32") return join(env.APPDATA ?? home, "jupyter");
  return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "jupyter");
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
 * The result is a shim or link when the manager has one, and the bare
 * program name otherwise: the launcher's PATH then picks the version (for
 * the managers that choose it from the notebook's directory, that is the
 * point).
 */
export function stableExecPath(execPath: string, options: ExecPathOptions = {}): string {
  const { exists = existsSync, platform = process.platform, env = process.env, pin = false } = options;
  if (pin || platform === "win32") return execPath;
  const segs = execPath.split("/");
  const name = segs[segs.length - 1];
  if (!name) return execPath;
  const shimOrBare = (candidate: string) => (exists(candidate) ? candidate : name);
  // `<root>/<dir>/…` where segs[i] is `dir`: the part before it.
  const rootBefore = (i: number) => segs.slice(0, i).join("/");

  // mise and asdf: <root>/installs/<tool>/<version>/…, shims in <root>/shims.
  for (let i = 1; i < segs.length - 3; i++) {
    if (segs[i] !== "installs") continue;
    const root = rootBefore(i);
    const manager = segs[i - 1] === "mise" || under(execPath, env.MISE_DATA_DIR, "/installs/") ||
      segs[i - 1] === ".asdf" || under(execPath, env.ASDF_DATA_DIR, "/installs/");
    if (manager) return shimOrBare(`${root}/shims/${name}`);
  }
  // volta: <root>/tools/image/<tool>/<version>/…, launchers in <root>/bin.
  for (let i = 1; i < segs.length - 4; i++) {
    if (segs[i] !== "tools" || segs[i + 1] !== "image") continue;
    const root = rootBefore(i);
    if (segs[i - 1] === ".volta" || segs[i - 1] === "volta" || under(execPath, env.VOLTA_HOME, "/tools/image/")) {
      return shimOrBare(`${root}/bin/${name}`);
    }
  }
  // Homebrew: <prefix>/Cellar/<formula>/<version>/bin/<name>, linked in <prefix>/bin.
  const cellar = segs.length - 5;
  if (cellar >= 1 && segs[cellar] === "Cellar" && segs[segs.length - 2] === "bin") {
    return shimOrBare(`${rootBefore(cellar)}/bin/${name}`);
  }
  // fnm, nvm and n have no shims: the version is whatever PATH says.
  if (
    execPath.includes("/fnm/node-versions/") || execPath.includes("/fnm_multishells/") ||
    execPath.includes("/.nvm/versions/") || under(execPath, env.NVM_DIR, "/versions/") ||
    execPath.includes("/n/versions/")
  ) return name;
  return execPath;
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
        cpSync(real, join(copy, "node_modules", ...name.split("/")), { recursive: true, dereference: true });
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
  /** False when the CLI already ran from there. */
  copied: boolean;
}

/**
 * Copy the installed package containing `entry` (a file inside it) to
 * `<dataDir>/cdp-kernel/<version>/` with every dependency it needs, so the
 * kernelspec doesn't depend on the npm prefix of one Node version. Replaces
 * a copy of the same version. Returns undefined, after saying why on `warn`,
 * when the package can't be copied: the caller then points at the original.
 */
export function stablePackage(
  entry: string,
  dataDir: string,
  version: string,
  warn: (message: string) => void = console.error,
): StableCopy | undefined {
  const root = stableRoot(dataDir);
  const dest = join(root, version);
  let real: string;
  try {
    real = realpathSync(entry);
  } catch {
    real = resolve(entry);
  }
  const realRoot = (() => {
    try {
      return realpathSync(root);
    } catch {
      return resolve(root);
    }
  })();
  if (real.startsWith(realRoot + sep)) {
    // Already running from a stable copy (any version): use it where it is.
    return { entry: real, dest: join(realRoot, relative(realRoot, real).split(sep)[0]), copied: false };
  }
  const pkgRoot = findPackageRoot(real);
  if (pkgRoot === undefined) {
    warn(`install: can't find the ${PACKAGE_NAME} package above ${entry}; pointing the kernelspec at it`);
    return undefined;
  }
  const staging = `${dest}.${process.pid}.tmp`;
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    cpSync(pkgRoot, staging, { recursive: true, dereference: true });
    completeDependencies(staging, pkgRoot);
    rmSync(dest, { recursive: true, force: true });
    renameSync(staging, dest);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    warn(
      `install: couldn't copy the package to ${dest} (${err instanceof Error ? err.message : String(err)}); ` +
        `pointing the kernelspec at ${entry}`,
    );
    return undefined;
  }
  return { entry: join(dest, relative(pkgRoot, real)), dest, copied: true };
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
    if (!entry.isDirectory() || !VERSION_DIR.test(entry.name)) continue;
    const prefixes = roots.map((r) => join(r, entry.name) + sep);
    const used = argvs.some((argv) => argv.some((arg) => prefixes.some((p) => resolve(arg).startsWith(p))));
    if (used) continue;
    rmSync(join(root, entry.name), { recursive: true, force: true });
    removed.push(join(root, entry.name));
  }
  return removed;
}
