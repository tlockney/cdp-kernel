export interface PackageSpecifier {
  name: string;
  range: string;
  subpath: string;
}

export function parsePackageSpecifier(spec: string): PackageSpecifier;
export function jsrToNpm(spec: string): PackageSpecifier;
export function aliasFor(name: string, range: string): string;
export type Installer = "npm" | "bun";
/** Where `installer` keeps its packages: $XDG_CACHE_HOME/cdp-kernel/<installer>, or CDPK_CACHE_DIR for npm. */
export function cacheDirPath(
  installer: Installer,
  env?: { [name: string]: string | undefined },
  home?: string,
): string;
export function installCommand(
  installer: Installer,
  alias: string,
  name: string,
  range: string,
): { cmd: string; args: string[]; env?: { [name: string]: string } };
/** How to spawn an install command; on Windows, npm runs through cmd.exe. */
export function spawnCommand(
  cmd: string,
  args: string[],
  platform?: string,
): { cmd: string; args: string[]; shell: boolean };
/** Runs an install; `env` is added to the process environment. */
export type InstallRunner = (
  cmd: string,
  args: string[],
  cwd: string,
  env?: { [name: string]: string },
) => { status: number | null; stderr?: string; error?: Error };
export function ensureInstalled(
  pkg: { name: string; range: string },
  installer?: Installer,
  options?: { lockFile?: string | null; run?: InstallRunner },
): { dir: string; alias: string };
/** ensureInstalled without blocking the event loop; `run` may return a promise. */
export function ensureInstalledAsync(
  pkg: { name: string; range: string },
  installer?: Installer,
  options?: {
    lockFile?: string | null;
    run?: (...args: Parameters<InstallRunner>) => ReturnType<InstallRunner> | Promise<ReturnType<InstallRunner>>;
  },
): Promise<{ dir: string; alias: string }>;
/** Where a package is installed in the cache, or null; never installs. */
export function installedPackageDir(
  pkg: { name: string; range: string },
  installer?: Installer,
  options?: { lockFile?: string | null },
): { dir: string; alias: string } | null;

export const LOCK_FILE: string;
export interface Lock {
  version: 1;
  packages: { [nameAtRange: string]: string };
}
export function findLockFile(dir: string): string | null;
export function readLock(path: string): Lock;
export function writeLock(path: string, lock: Lock): void;
export function withInstallLock<T>(dir: string, fn: () => T, options?: { timeoutMs?: number }): T;
export function withInstallLockAsync<T>(dir: string, fn: () => T | Promise<T>, options?: { timeoutMs?: number }): Promise<T>;
/** Compiles one TypeScript or JSX file with the esbuild binary at `binary`; `run` is replaceable in tests. */
export function compileTypeScript(
  source: string,
  filename: string,
  binary: string,
  run?: (cmd: string, args: string[], options: object) => { status: number | null; stdout: string; stderr: string; error?: Error },
  loader?: "ts" | "tsx" | "jsx",
): string;
export interface LoadResult {
  format?: string | null;
  source?: string | ArrayBuffer | ArrayBufferView | null;
  shortCircuit?: boolean;
}
/** The load hook: Node's own result unless its type stripping would reject the file; .tsx/.jsx always compiled. */
export function loadTypeScript(
  url: string,
  context: object,
  nextLoad: (url: string, context: object) => LoadResult,
  binary: string | undefined,
): LoadResult;
export function installNodeResolveHooks(urls: { shimUrl: string; replUrl: string }): void;
