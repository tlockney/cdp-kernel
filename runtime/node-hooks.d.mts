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
): { cmd: string; args: string[] };
export function ensureInstalled(
  pkg: { name: string; range: string },
  installer?: Installer,
): { dir: string; alias: string };
export function installNodeResolveHooks(urls: { shimUrl: string; replUrl: string }): void;
