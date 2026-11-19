// TypeScript's language service over a notebook (#263) on Node: the
// service itself is NotebookTypesCore (src/notebook-types-core.ts), which
// reads files, joins paths and finds installed packages through what it's
// given (#524, so a page can run it too). This gives it ts.sys, node:path
// and the kernel's npm cache.

import type TS from "typescript";
import { join } from "node:path";
import { findLockFile, installedPackageDir, jsrToNpm, parsePackageSpecifier } from "../runtime/node-hooks.mjs";
import { type CachedPackage, NotebookTypesCore, type NotebookTypesOptions } from "./notebook-types-core.ts";

export * from "./notebook-types-core.ts";

/** Where an npm: or jsr: import is installed in the kernel's npm cache, if it is. */
function cachedPackage(options: NotebookTypesOptions, specifier: string): CachedPackage | null {
  try {
    const pkg = specifier.startsWith("npm:")
      ? parsePackageSpecifier(specifier.slice(4))
      : jsrToNpm(specifier.slice(4));
    const installer = options.npmCache ?? "npm";
    const installed = installedPackageDir(pkg, installer, { lockFile: findLockFile(options.notebookDir) });
    return installed === null ? null : { ...installed, subpath: pkg.subpath };
  } catch {
    return null;
  }
}

export class NotebookTypes extends NotebookTypesCore {
  constructor(ts: typeof TS, options: NotebookTypesOptions) {
    const sys = ts.sys;
    super(ts, options, {
      fs: {
        readFile: sys.readFile,
        fileExists: sys.fileExists,
        directoryExists: sys.directoryExists,
        getDirectories: sys.getDirectories,
        realpath: sys.realpath,
        readDirectory: sys.readDirectory,
      },
      join,
      cachedPackage: (specifier) => cachedPackage(options, specifier),
    });
  }
}
