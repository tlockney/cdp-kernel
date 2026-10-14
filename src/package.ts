// How cdp-kernel was installed, and what follows from it.
//
// It ships three ways: an npm package run by Node (compiled dist/), a JSR
// package run by Deno (TypeScript fetched from https://jsr.io), and a local
// checkout run by either. Two things depend on which:
//   - the kernelspec argv that relaunches the kernel, and
//   - where the target runtime loads runtime/*.mjs from. A Node target can't
//     import its bootstrap from an https URL, so a JSR install copies those
//     files into a local cache first.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Kept equal to package.json and deno.jsonc by test/package.test.ts. */
export const VERSION = "0.1.1";

export const RUNTIME_FILES = [
  "bootstrap.mjs",
  "display.mjs",
  "comm.mjs",
  "widget.mjs",
  "node-hooks.mjs",
  "deno-compat.mjs",
] as const;

export type HostRuntime = "node" | "deno";

export function hostRuntime(): HostRuntime {
  return process.versions.deno === undefined ? "node" : "deno";
}

/** Where the CLI module was loaded from. */
export type Origin =
  | { kind: "file"; path: string }
  | { kind: "jsr"; specifier: string }
  | { kind: "remote"; url: string };

const JSR_URL = /^https:\/\/jsr\.io\/(@[^/]+\/[^/]+)\/([^/]+)\//;

/** `moduleUrl` is the CLI's import.meta.url. */
export function moduleOrigin(moduleUrl: string): Origin {
  if (moduleUrl.startsWith("file:")) return { kind: "file", path: fileURLToPath(moduleUrl) };
  const jsr = JSR_URL.exec(moduleUrl);
  // Pin the exact version so an installed kernelspec keeps running the
  // release it was installed from.
  if (jsr) return { kind: "jsr", specifier: `jsr:${jsr[1]}@${jsr[2]}/cli` };
  return { kind: "remote", url: moduleUrl };
}

/** The command a kernelspec runs to start this kernel. */
export function kernelArgv(host: HostRuntime, execPath: string, origin: Origin, args: string[]): string[] {
  if (origin.kind === "remote") {
    throw new Error(`cdp-kernel was loaded from ${origin.url}; install it from npm or JSR, or run a local checkout`);
  }
  if (host === "node") {
    if (origin.kind !== "file") throw new Error("a JSR install must be run with Deno");
    return [execPath, origin.path, ...args];
  }
  // Deno: a checkout needs its deno.jsonc import map; a JSR package brings
  // its own, so skip whatever config the notebook's directory has.
  const flags = origin.kind === "jsr" ? ["--no-config", "--no-lock"] : ["--no-lock"];
  const entry = origin.kind === "jsr" ? origin.specifier : origin.path;
  return [execPath, "run", "--allow-all", ...flags, entry, ...args];
}

export function cacheRoot(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "cdp-kernel");
}

export type FetchText = (url: string) => Promise<string>;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetching ${url}: ${res.status} ${res.statusText}`);
  return await res.text();
}

/**
 * A local directory holding runtime/*.mjs. `baseUrl` is the runtime/
 * directory's URL relative to the calling module. A file: URL is used in
 * place; anything else is copied once into a cache keyed by version and
 * URL.
 */
export async function runtimeDir(baseUrl: string, cache: string = cacheRoot(), get: FetchText = fetchText): Promise<string> {
  if (baseUrl.startsWith("file:")) return fileURLToPath(baseUrl);
  const key = createHash("sha256").update(baseUrl).digest("hex").slice(0, 12);
  const dir = join(cache, "runtime", `${VERSION}-${key}`);
  if (RUNTIME_FILES.every((name) => existsSync(join(dir, name)))) return dir;
  // Fill a sibling directory, then rename, so a half-copied cache is never
  // picked up by the check above.
  const staging = `${dir}.${process.pid}.tmp`;
  mkdirSync(staging, { recursive: true });
  try {
    for (const name of RUNTIME_FILES) {
      writeFileSync(join(staging, name), await get(new URL(name, baseUrl).href));
    }
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  try {
    renameSync(staging, dir);
  } catch (err) {
    // Another kernel finished first; theirs is complete.
    if (!RUNTIME_FILES.every((name) => existsSync(join(dir, name)))) throw err;
  }
  return dir;
}
