export interface PackageSpecifier {
  name: string;
  range: string;
  subpath: string;
}

export function parsePackageSpecifier(spec: string): PackageSpecifier;
export function jsrToNpm(spec: string): PackageSpecifier;
export function aliasFor(name: string, range: string): string;
export type Installer = "npm" | "bun";
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

export const LOCK_FILE: string;
export interface Lock {
  version: 1;
  packages: { [nameAtRange: string]: string };
}
export function findLockFile(dir: string): string | null;
export function readLock(path: string): Lock;
export function writeLock(path: string, lock: Lock): void;
export function withInstallLock<T>(dir: string, fn: () => T, options?: { timeoutMs?: number }): T;
export function installNodeResolveHooks(urls: { shimUrl: string; replUrl: string }): void;
