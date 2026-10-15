// A notebook's Deno project config, for Deno targets.
//
// `deno jupyter` honours the project's deno.json: its import map,
// nodeModulesDir and JSX/decorator compilerOptions. Here those come from two
// places: the target runtime gets `--config <path>` (import map, npm
// resolution), and the host's cell transformer gets the compiler options,
// because cells are transpiled by esbuild in the host, not by Deno.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CellTransformOptions, JsxOptions } from "./transform.ts";

export type { CellTransformOptions, JsxOptions };

/** Deno looks for these, in this order, in each directory. */
export const DENO_CONFIG_NAMES = ["deno.json", "deno.jsonc"] as const;

/** The nearest deno.json(c) at or above `startDir`, as Deno resolves it. */
export function findDenoConfig(startDir: string): string | null {
  for (let dir = startDir; ; dir = dirname(dir)) {
    for (const name of DENO_CONFIG_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Parses JSON with comments and trailing commas (deno.jsonc). Comments and
 * trailing commas are removed outside strings, then the rest goes to
 * JSON.parse, so errors are JSON.parse's SyntaxErrors.
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return JSON.parse(stripTrailingCommas(out));
}

/** Drops commas that only whitespace separates from a closing } or ]. */
function stripTrailingCommas(json: string): string {
  // Walks strings intact for the same reason as above: a string can
  // legitimately contain ",}".
  let out = "";
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (ch === '"') {
      const start = i++;
      while (i < json.length && json[i] !== '"') i += json[i] === "\\" ? 2 : 1;
      out += json.slice(start, i + 1);
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j])) j++;
      if (json[j] === "}" || json[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

/** Maps a deno.json's compilerOptions onto the cell transformer's options. */
export function transformOptionsFromConfig(config: unknown): CellTransformOptions {
  if (typeof config !== "object" || config === null) return {};
  const compilerOptions = (config as Record<string, unknown>).compilerOptions;
  if (typeof compilerOptions !== "object" || compilerOptions === null) return {};
  const opts = compilerOptions as Record<string, unknown>;
  const result: CellTransformOptions = {};

  const jsx = stringField(opts, "jsx");
  if (jsx === "react-jsx" || jsx === "react-jsxdev" || jsx === "precompile") {
    // precompile is Deno's server-side optimisation of the automatic
    // runtime; for a notebook cell the automatic runtime is equivalent.
    const importSource = stringField(opts, "jsxImportSource");
    result.jsx = { mode: "automatic", development: jsx === "react-jsxdev" };
    if (importSource !== undefined) result.jsx.importSource = importSource;
  } else if (jsx === "react") {
    const factory = stringField(opts, "jsxFactory");
    const fragment = stringField(opts, "jsxFragmentFactory");
    const classic: JsxOptions = { mode: "classic" };
    if (factory !== undefined) classic.factory = factory;
    if (fragment !== undefined) classic.fragment = fragment;
    result.jsx = classic;
  }
  if (opts.experimentalDecorators === true) result.experimentalDecorators = true;
  return result;
}

export interface DenoProject {
  configPath: string;
  transform: CellTransformOptions;
}

/** The Deno project a notebook directory belongs to, if any. */
export function loadDenoProject(notebookDir: string): DenoProject | null {
  const configPath = findDenoConfig(notebookDir);
  if (configPath === null) return null;
  let config: unknown;
  try {
    config = parseJsonc(readFileSync(configPath, "utf8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot read Deno config ${configPath}: ${reason}`);
  }
  return { configPath, transform: transformOptionsFromConfig(config) };
}
