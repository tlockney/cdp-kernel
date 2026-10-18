// Types for a Deno target's imports (#275). Deno resolves npm:, jsr:, URLs
// and its project's import map itself and keeps what it fetched in its own
// cache, so the language service asks it where a specifier went:
// `deno info --json` over a one-line module importing it. npm packages map
// to their directory in Deno's npm cache; remote modules (jsr:, https:)
// are stored under hashed names without an extension, so the language
// service sees each under a virtual path built from its URL, which keeps
// relative imports between them working.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type DenoResolution =
  | { kind: "npm"; dir: string; subpath: string }
  | { kind: "remote"; path: string };

interface DenoInfo {
  roots: string[];
  modules: { specifier: string; local?: string; dependencies?: { specifier: string; code?: { specifier: string } }[] }[];
  redirects: { [from: string]: string };
  npmPackages: { [id: string]: { localPath?: string } };
}

export type RunDeno = (args: string[]) => { status: number | null; stdout: string };

function runDeno(deno: string): RunDeno {
  return (args) => {
    const result = spawnSync(deno, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
    return { status: result.status, stdout: result.stdout ?? "" };
  };
}

export class DenoResolver {
  readonly #run: RunDeno;
  readonly #config: string | null;
  /** Where remote modules appear to the language service. */
  readonly root: string;
  readonly #lookups = new Map<string, DenoResolution | null>();
  /** Virtual path -> the cached file holding that URL's module. */
  readonly #remote = new Map<string, string>();

  constructor(
    { deno = "deno", config = null, root }: { deno?: string; config?: string | null; root: string },
    run: RunDeno = runDeno(deno),
  ) {
    this.#run = run;
    this.#config = config;
    this.root = root;
  }

  /** The virtual path for a remote module's URL, e.g. <root>/https/jsr.io/@std/path/1.1.6/mod.ts. */
  pathFor(url: string): string | null {
    const m = /^(https?):\/\/(.+)$/.exec(url);
    return m ? join(this.root, m[1], m[2]) : null;
  }

  /** The cached file behind a virtual path, if a lookup has found it. */
  localFile(path: string): string | undefined {
    return this.#remote.get(path);
  }

  /** Where `specifier` resolves for Deno, from what's already in its cache. */
  lookup(specifier: string): DenoResolution | null {
    if (this.#lookups.has(specifier)) return this.#lookups.get(specifier) ?? null;
    const resolution = this.#lookup(specifier);
    this.#lookups.set(specifier, resolution);
    return resolution;
  }

  #lookup(specifier: string): DenoResolution | null {
    const dir = mkdtempSync(join(tmpdir(), "cdpk-deno-info-"));
    try {
      const entry = join(dir, "entry.ts");
      writeFileSync(entry, `import ${JSON.stringify(specifier)};\n`);
      const flags = this.#config === null ? ["--node-modules-dir=none"] : ["--config", this.#config];
      const result = this.#run(["info", "--json", "--no-lock", ...flags, entry]);
      if (result.status !== 0) return null;
      return this.#read(JSON.parse(result.stdout) as DenoInfo);
    } catch {
      return null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  #read(info: DenoInfo): DenoResolution | null {
    for (const mod of info.modules) {
      const path = mod.local === undefined ? null : this.pathFor(mod.specifier);
      if (path !== null && mod.local !== undefined) this.#remote.set(path, mod.local);
    }
    const root = info.modules.find((m) => m.specifier === info.roots[0]);
    const dep = root?.dependencies?.[0];
    let target = dep?.code?.specifier ?? dep?.specifier;
    if (target === undefined) return null;
    for (let i = 0; i < 10 && info.redirects[target] !== undefined; i++) target = info.redirects[target];
    const npm = /^npm:\/?((?:@[^/]+\/)?[^/@]+@[^/]+)(\/.*)?$/.exec(target);
    if (npm) {
      const dir = info.npmPackages[npm[1]]?.localPath;
      return dir === undefined ? null : { kind: "npm", dir, subpath: npm[2] ?? "" };
    }
    const path = this.pathFor(target);
    return path !== null && this.#remote.has(path) ? { kind: "remote", path } : null;
  }
}

/** `deno types`: declarations for the Deno namespace and its web globals. */
export function denoTypes(run: RunDeno = runDeno("deno")): string | null {
  const result = run(["types"]);
  return result.status === 0 ? result.stdout : null;
}
