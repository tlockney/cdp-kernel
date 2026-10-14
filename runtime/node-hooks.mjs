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
// Uses module.registerHooks (synchronous, in-thread; Node >= 23.5), so the
// install can run with spawnSync inside resolve.

import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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

function cacheDir() {
  const dir = process.env.CDPK_CACHE_DIR ?? join(homedir(), ".cache", "cdp-kernel", "npm");
  if (!existsSync(join(dir, "package.json"))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), '{ "private": true }\n');
    writeFileSync(join(dir, ".npmrc"), "@jsr:registry=https://npm.jsr.io\n");
  }
  return dir;
}

function ensureInstalled({ name, range }) {
  const dir = cacheDir();
  const alias = aliasFor(name, range);
  if (!existsSync(join(dir, "node_modules", alias, "package.json"))) {
    const result = spawnSync(
      "npm",
      ["install", "--no-audit", "--no-fund", "--loglevel=error", `${alias}@npm:${name}@${range}`],
      { cwd: dir, encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`npm install ${name}@${range} failed:\n${result.stderr || result.error}`);
    }
  }
  return { dir, alias };
}

export function installNodeResolveHooks({ shimUrl, replUrl }) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      let pkg = null;
      if (specifier.startsWith("npm:")) pkg = parsePackageSpecifier(specifier.slice(4));
      else if (specifier.startsWith("jsr:")) pkg = jsrToNpm(specifier.slice(4));
      if (pkg) {
        const { dir, alias } = ensureInstalled(pkg);
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
