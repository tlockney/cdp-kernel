export interface PackageSpecifier {
  name: string;
  range: string;
  subpath: string;
}

export function parsePackageSpecifier(spec: string): PackageSpecifier;
export function jsrToNpm(spec: string): PackageSpecifier;
export function aliasFor(name: string, range: string): string;
export function installNodeResolveHooks(urls: { shimUrl: string; replUrl: string }): void;
