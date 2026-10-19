// A Workers project's bindings for the workerd target (#26).
//
// When the notebook sits in a Workers project (a wrangler config at or above
// its directory), the driver Worker runs on the project's own Miniflare, the
// simulator `wrangler dev` uses, so cells get the project's KV, D1, R2,
// Durable Objects and vars as `env`, and its default export as `worker`.
// wrangler turns the config into Miniflare options
// (unstable_getMiniflareWorkerOptions); the project's main module is
// bundled next to the driver, so its Durable Object classes are exported
// from the same Worker. Neither wrangler nor Miniflare is a dependency of
// cdp-kernel: they're loaded from the project, so they match its version.

import process from "node:process";
import { builtinModules, createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import type { CdpParams } from "./cdp.ts";
import { childPids, reap } from "./children.ts";
import { runtimeDir } from "./package.ts";
import { withStartTimeout } from "./target-api.ts";
import { cellMeta, WORKER_MODULES, type WorkerHost } from "./workerd-target.ts";
import type { WsChannel } from "./ws-client.ts";

export const WRANGLER_CONFIGS = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];

/** The nearest wrangler config at or above `cwd`, or null. */
export function findWranglerConfig(cwd: string): string | null {
  for (let dir = cwd;; dir = dirname(dir)) {
    for (const name of WRANGLER_CONFIGS) {
      if (existsSync(join(dir, name))) return join(dir, name);
    }
    if (dirname(dir) === dir) return null;
  }
}

/**
 * The Worker's main module: the project's named exports (Durable Object
 * classes and the like), the driver's fetch handler as the default, and the
 * project's own default export as the `worker` global.
 */
export const PROJECT_MAIN = 'import * as project from "./project.mjs";\n' +
  'export * from "./project.mjs";\n' +
  'export { default } from "./workerd-worker.mjs";\n' +
  "globalThis.worker = project.default;\n";

/**
 * The project's flags, plus nodejs_compat, which the driver needs for
 * node:util, unless the project chose a variant itself. Its date can't say
 * whether nodejs_compat is implied: an older Miniflare runs an older workerd
 * than the date names. On a newer one the flag only draws a warning.
 */
export function compatibilityFlagsFor(flags: string[]): string[] {
  if (flags.some((f) => /^(?:no_)?nodejs_compat/.test(f))) return flags;
  return [...flags, "nodejs_compat"];
}

const DEFAULT_COMPATIBILITY_DATE = "2026-08-04";

// --- The parts of wrangler and Miniflare used here ---------------------------

interface WorkerOptions {
  [key: string]: unknown;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  bindings?: { [name: string]: unknown };
}

interface Wrangler {
  unstable_getMiniflareWorkerOptions(configPath: string): {
    workerOptions: WorkerOptions;
    main?: string;
    define?: { [name: string]: string };
  };
}

interface MiniflareWebSocket {
  accept(): void;
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
}

interface MiniflareResponse {
  status: number;
  webSocket: MiniflareWebSocket | null;
  text(): Promise<string>;
}

interface Miniflare {
  ready: Promise<unknown>;
  dispatchFetch(url: string, init: { headers: { [name: string]: string } }): Promise<MiniflareResponse>;
  dispose(): Promise<void>;
}

interface MiniflareModule {
  Miniflare: new (options: object) => Miniflare;
  /** Miniflare 5: options in Miniflare 4's shape, which wrangler produces, converted. */
  convertV4MiniflareOptions?: (options: object) => object;
}

function isWrangler(value: unknown): value is Wrangler {
  return typeof (value as Wrangler | null)?.unstable_getMiniflareWorkerOptions === "function";
}

function isMiniflareModule(value: unknown): value is MiniflareModule {
  return typeof (value as MiniflareModule | null)?.Miniflare === "function";
}

function isRecord(value: unknown): value is CdpParams {
  return typeof value === "object" && value !== null;
}

/** Loads wrangler from the project, and the Miniflare that wrangler uses. */
function loadTooling(configPath: string): { wrangler: Wrangler; miniflare: MiniflareModule; version: string } {
  const fromProject = createRequire(join(dirname(configPath), "package.json"));
  let wranglerPath: string;
  try {
    wranglerPath = fromProject.resolve("wrangler");
  } catch {
    throw new Error("wrangler isn't installed in the project (npm install --save-dev wrangler)");
  }
  const fromWrangler = createRequire(wranglerPath);
  const wrangler: unknown = fromWrangler(wranglerPath);
  const miniflare: unknown = fromWrangler("miniflare");
  if (!isWrangler(wrangler)) throw new Error("this wrangler has no unstable_getMiniflareWorkerOptions");
  if (!isMiniflareModule(miniflare)) throw new Error("couldn't load the Miniflare that wrangler uses");
  const pkg: unknown = JSON.parse(readFileSync(fromWrangler.resolve("miniflare/package.json"), "utf8"));
  const version = isRecord(pkg) && typeof pkg.version === "string" ? pkg.version : "";
  return { wrangler, miniflare, version };
}

const NODE_BUILTINS = builtinModules.filter((name) => !name.startsWith("_") && !name.startsWith("node:"));

/** Packages import Node builtins by bare name too; workerd and celld want node:. */
export function builtinAliases(): { [name: string]: string } {
  return Object.fromEntries(NODE_BUILTINS.map((name) => [name, `node:${name}`]));
}

/** The project's main module as one ES module; builtins stay imports. */
export async function bundleProject(main: string, define: { [name: string]: string } = {}): Promise<string> {
  const result = await build({
    entryPoints: [main],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["browser", "module", "main"],
    // Packages import Node builtins by bare name too; workerd wants node:.
    alias: builtinAliases(),
    external: ["node:*", "cloudflare:*", "workerd:*"],
    define,
    target: "esnext",
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

/** Miniflare's WebSocket as the session channel. */
function channelOf(ws: MiniflareWebSocket): WsChannel {
  ws.accept();
  return {
    send: (text) => ws.send(text),
    onMessage: (listener) => ws.addEventListener("message", (event) => listener(String(event.data))),
    onClose: (listener) => ws.addEventListener("close", listener),
    close() {
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/** The driver on the project's Miniflare. */
class MiniflareHost implements WorkerHost {
  readonly runtime: string;
  readonly project: string;
  readonly channel: WsChannel;
  readonly #mf: Miniflare;
  readonly #exitListeners: ((code: number | null) => void)[] = [];
  #stopped = false;

  readonly #forget: (() => void)[];

  constructor(mf: Miniflare, channel: WsChannel, version: string, project: string, workerd: number[]) {
    this.#mf = mf;
    // Miniflare kills its workerd only on a normal exit; the helper in
    // src/children.ts kills it if this process is SIGKILLed (#241).
    this.#forget = workerd.map(reap);
    this.channel = channel;
    this.runtime = `miniflare ${version}`.trim();
    this.project = project;
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    // dispose() ends workerd even mid-cell.
    void this.#mf.dispose().catch(() => {}).finally(() => {
      for (const forget of this.#forget) forget();
      for (const listener of this.#exitListeners) listener(null);
    });
  }

  onExit(listener: (code: number | null) => void): void {
    this.#exitListeners.push(listener);
  }
}

/** Starts the driver on the project's Miniflare with its bindings. */
export async function startMiniflare(configPath: string, cwd: string, startTimeoutMs?: number): Promise<WorkerHost> {
  const { wrangler, miniflare, version } = loadTooling(configPath);
  const projectDir = dirname(configPath);
  const { workerOptions, main, define } = wrangler.unstable_getMiniflareWorkerOptions(configPath);
  const source = await runtimeDir(new URL("../runtime/", import.meta.url).href);
  const module = (path: string, contents: string) => ({ type: "ESModule", path, contents });
  const modules = [
    module("main.mjs", main ? PROJECT_MAIN : 'export { default } from "./workerd-worker.mjs";\n'),
    ...WORKER_MODULES.map((name) => module(name, readFileSync(join(source, name), "utf8"))),
    ...(main ? [module("project.mjs", await bundleProject(main, define))] : []),
  ];
  const token = randomBytes(32).toString("hex");
  const date = workerOptions.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE;
  // Its own state directory, beside `wrangler dev`'s: two runtimes must
  // never open the same Durable Object.
  const state = join(projectDir, ".wrangler", "state", "cdp-kernel");
  const v5 = typeof miniflare.convertV4MiniflareOptions === "function";
  const options = {
    ...workerOptions,
    name: "cdpk",
    modules,
    modulesRoot: "/",
    unsafeEvalBinding: "UNSAFE",
    compatibilityDate: date,
    compatibilityFlags: compatibilityFlagsFor(workerOptions.compatibilityFlags ?? []),
    bindings: { ...workerOptions.bindings, TOKEN: token, META: JSON.stringify(cellMeta(cwd)) },
    // Miniflare 5 renamed Miniflare 4's defaultPersistRoot.
    ...(v5 ? { resourcePersistencePath: state } : { defaultPersistRoot: state }),
  };
  // Miniflare's workerd is this process's child; it doesn't say which.
  const before = new Set(childPids(process.pid, "workerd"));
  const mf = new miniflare.Miniflare(v5 && miniflare.convertV4MiniflareOptions ? miniflare.convertV4MiniflareOptions(options) : options);
  try {
    // Miniflare listens on a loopback TCP port; the token is what keeps
    // other local processes from the driver.
    const connect = mf.ready.then(() => mf.dispatchFetch("http://cdpk/", { headers: { Upgrade: "websocket", "x-cdpk-token": token } }));
    const res = await withStartTimeout(connect, "Miniflare", startTimeoutMs);
    if (res.status !== 101 || res.webSocket === null) throw new Error(`the driver answered ${res.status}: ${await res.text()}`);
    const workerd = childPids(process.pid, "workerd").filter((pid) => !before.has(pid));
    return new MiniflareHost(mf, channelOf(res.webSocket), version, configPath, workerd);
  } catch (err) {
    await mf.dispose().catch(() => {});
    throw err;
  }
}
