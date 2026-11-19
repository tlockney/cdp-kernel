// Where the language service gets TypeScript from (#513). The package
// doesn't depend on `typescript` (24 MB, and every stable install copy
// from #509 would carry it): the notebook project's own is used when its
// major version is one the kernel supports, else one copy installed on
// first use into the kernel's npm cache, which every installed kernel
// version shares.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type TS from "typescript";
import { ensureInstalledAsync, installedPackageDir } from "../runtime/node-hooks.mjs";

/**
 * The TypeScript a cache install takes: the range the kernel is tested
 * with. TypeScript 7 changes the API the worker uses (#515), so the range
 * stays within 6. Keep it equal to package.json's devDependency
 * (test/typescript-package.test.ts).
 */
export const TYPESCRIPT_RANGE = "^6.0.3";
const SUPPORTED_MAJORS = [6];

const REQUEST = { name: "typescript", range: TYPESCRIPT_RANGE };

export interface FoundTypeScript {
  /** The package directory (with package.json and lib/). */
  dir: string;
  version: string;
  from: "project" | "cache";
}

function readVersion(dir: string): string | null {
  try {
    const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown };
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

function supported(version: string): boolean {
  return SUPPORTED_MAJORS.includes(Number(version.split(".")[0]));
}

/**
 * The notebook project's own typescript: the nearest node_modules/typescript
 * at or above `notebookDir`, if its major is supported. Not NODE_PATH or
 * global folders, which aren't the project's.
 */
export function projectTypeScript(notebookDir: string): FoundTypeScript | null {
  for (let at = resolve(notebookDir);; at = dirname(at)) {
    const dir = join(at, "node_modules", "typescript");
    const version = readVersion(dir);
    if (version !== null) return supported(version) ? { dir, version, from: "project" } : null;
    if (dirname(at) === at) return null;
  }
}

/** The typescript in the kernel's npm cache, if it's installed. Installs nothing. */
export function cachedTypeScript(): FoundTypeScript | null {
  const installed = installedPackageDir(REQUEST);
  if (installed === null) return null;
  const dir = join(installed.dir, "node_modules", installed.alias);
  const version = readVersion(dir);
  return version === null ? null : { dir, version, from: "cache" };
}

/** The typescript the language service would load now, without installing one. */
export function findTypeScript(notebookDir: string): FoundTypeScript | null {
  return projectTypeScript(notebookDir) ?? cachedTypeScript();
}

/**
 * findTypeScript, else installs it into the npm cache (in the background:
 * the event loop stays free). Rejects if the install fails, e.g. offline.
 * `install` is replaceable in tests.
 */
export async function locateTypeScript(
  notebookDir: string,
  install: (request: { name: string; range: string }) => Promise<unknown> = (request) => ensureInstalledAsync(request),
): Promise<FoundTypeScript> {
  const found = findTypeScript(notebookDir);
  if (found !== null) return found;
  await install(REQUEST);
  const installed = cachedTypeScript();
  if (installed === null) throw new Error(`typescript@${TYPESCRIPT_RANGE} isn't in the npm cache after installing it`);
  return installed;
}

/** Loads a located typescript. */
export function requireTypeScript(found: FoundTypeScript): typeof TS {
  return createRequire(join(found.dir, "package.json"))(found.dir) as typeof TS;
}

export interface LoadOptions {
  /** Whether the kernel host is Deno, which resolves npm: itself, without the npm CLI. */
  deno?: boolean;
  /** Imports an npm: specifier (Deno only); replaceable in tests. */
  importNpm?: (specifier: string) => Promise<unknown>;
  /** See locateTypeScript. */
  install?: (request: { name: string; range: string }) => Promise<unknown>;
}

/**
 * The typescript the language service runs on: the project's or the npm
 * cache's, else, on a Deno host (a JSR install, which may have no npm),
 * Deno's own `npm:typescript` from its cache, else installed into the npm
 * cache. Rejects if none can be had (offline).
 */
export async function loadTypeScript(notebookDir: string, options: LoadOptions = {}): Promise<typeof TS> {
  const {
    deno = "Deno" in globalThis,
    // A variable, not a literal: Node's type check can't resolve npm: specifiers.
    importNpm = (specifier: string) => import(specifier),
    install,
  } = options;
  const found = findTypeScript(notebookDir);
  if (found !== null) return requireTypeScript(found);
  if (deno) {
    const module = (await importNpm(`npm:typescript@${TYPESCRIPT_RANGE}`)) as { default?: typeof TS };
    return module.default ?? (module as typeof TS);
  }
  return requireTypeScript(await locateTypeScript(notebookDir, install));
}
