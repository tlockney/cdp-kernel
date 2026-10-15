// @ts-self-types="./node-modules-resolve.d.mts"
// Resolves a bare package import against a notebook directory's
// node_modules, for Deno targets in a Deno project (#13).
//
// Deno resolves package.json dependencies relative to the *importing*
// module. Cell imports are issued from runtime/bootstrap.mjs, outside the
// project, and code evaluated over the inspector resolves against the
// notebook directory treated as a file (one level too high), so neither
// finds the project's node_modules. Resolving the package to an absolute
// file URL here sidesteps both; the package's own imports then resolve
// normally from inside node_modules.
//
// Implements the parts of Node's package resolution notebooks need:
// "exports" (string, subpath map, "*" patterns, nested conditions taken in
// the package's key order), then "module"/"main"/index.js. Returns null when
// no node_modules has the package, so the caller can fall back to Deno's
// own resolution (import map, npm:, jsr:, builtins).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// The conditions Deno matches for npm packages, plus the common "module".
const CONDITIONS = new Set(["deno", "node", "import", "module", "default"]);

/** True for "pkg", "@scope/pkg", "pkg/sub"; false for paths, URLs, aliases. */
export function isBareSpecifier(specifier) {
  if (/^[./]/.test(specifier) || specifier.startsWith("#")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return false; // npm:, node:, file:, https:
  if (specifier.startsWith("@")) return /^@[^/]+\/[^/]+/.test(specifier) && !specifier.startsWith("@/");
  return true;
}

function splitPackage(specifier) {
  const parts = specifier.split("/");
  const nameLength = specifier.startsWith("@") ? 2 : 1;
  return { name: parts.slice(0, nameLength).join("/"), subpath: parts.slice(nameLength).join("/") };
}

function findPackageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

/** Picks a target from an exports value: a string, or nested conditions. */
function conditionalTarget(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = conditionalTarget(item);
      if (target !== null) return target;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (!CONDITIONS.has(key)) continue;
      const target = conditionalTarget(nested);
      if (target !== null) return target;
    }
  }
  return null;
}

function exportsTarget(exports, subpath) {
  const key = subpath === "" ? "." : `./${subpath}`;
  const isSubpathMap = exports !== null && typeof exports === "object" && !Array.isArray(exports) &&
    Object.keys(exports).some((k) => k.startsWith("."));
  if (!isSubpathMap) return key === "." ? conditionalTarget(exports) : null;
  if (Object.hasOwn(exports, key)) return conditionalTarget(exports[key]);
  for (const [pattern, value] of Object.entries(exports)) {
    const star = pattern.indexOf("*");
    if (star === -1) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (key.startsWith(prefix) && key.endsWith(suffix) && key.length >= prefix.length + suffix.length) {
      const match = key.slice(prefix.length, key.length - suffix.length);
      const target = conditionalTarget(value);
      return target === null ? null : target.replaceAll("*", match);
    }
  }
  return null;
}

/** An absolute file URL for `specifier`, or null if no node_modules has it. */
export function resolveFromNodeModules(specifier, fromDir) {
  if (!isBareSpecifier(specifier)) return null;
  const { name, subpath } = splitPackage(specifier);
  const pkgDir = findPackageDir(name, fromDir);
  if (pkgDir === null) return null;
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));

  let target;
  if (pkg.exports !== undefined) {
    target = exportsTarget(pkg.exports, subpath);
    if (target === null) return null; // not exported: not importable
  } else if (subpath !== "") {
    target = subpath;
  } else {
    target = pkg.module ?? pkg.main ?? "index.js";
  }
  return pathToFileURL(join(pkgDir, target)).href;
}
