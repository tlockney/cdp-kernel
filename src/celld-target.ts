// The celld target (#25). celld (denoland/celld) runs Workers and Durable
// Objects on its own storage; like workerd it has no I/O outside a request,
// so it runs the same driver Worker (runtime/workerd-worker.mjs) over the
// same WebSocket session (src/workerd-target.ts). The differences:
//   - celld has no UnsafeEval binding and doesn't need one: the driver uses
//     a plain global eval.
//   - It listens only on TCP, so the session is a loopback WebSocket opened
//     with a per-launch token (in the query string: the host's built-in
//     WebSocket can't set headers).
//   - It takes one module, so the host bundles the driver (and a project's
//     main) with esbuild and hands celld the result with `no_bundle`.
// In a celld project (a wrangler.jsonc or wrangler.json at or above the
// notebook), its bindings come along: the generated config copies them, and
// lives in the project's .celld/cdp-kernel, so state stays beside, not in,
// `celld dev`'s own.

import process from "node:process";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import { type CdpParams, isRecord } from "./cdp.ts";
import { parseJsonc } from "./deno-config.ts";
import { runtimeDir } from "./package.ts";
import { childPids, killOnExit, reapWith } from "./children.ts";
import type { TargetEvents } from "./target.ts";
import type { WsChannel } from "./ws-client.ts";
import { cellMeta, type WorkerHost, WorkerdTarget } from "./workerd-target.ts";
import { builtinAliases, findWranglerConfig } from "./workers-project.ts";

/** The project keys the generated config keeps: bindings and compatibility. */
export const PROJECT_KEYS = [
  "compatibility_date",
  "compatibility_flags",
  "durable_objects",
  "migrations",
  "vars",
  "d1_databases",
  "kv_namespaces",
  "r2_buckets",
  "queues",
  "workflows",
  "services",
  "worker_loaders",
];

/**
 * The celld config for the driver: the project's bindings (or none), the
 * pre-built driver as its one module, and the kernel's token and import.meta
 * as vars, which the driver hides from cells' `env`.
 */
export function celldConfig(
  project: CdpParams | null,
  { token, meta }: { token: string; meta: { url: string; dirname: string; filename: string } },
): CdpParams {
  const config: CdpParams = { name: "cdpk", main: "driver.mjs", no_bundle: true, compatibility_date: "2026-09-01" };
  for (const key of PROJECT_KEYS) if (project && project[key] !== undefined) config[key] = project[key];
  const vars = project && typeof project.vars === "object" && project.vars !== null ? project.vars : {};
  config.vars = { ...vars, TOKEN: token, META: JSON.stringify(meta) };
  return config;
}

/**
 * celld's installer puts it in ~/.local/bin, which a Jupyter server's PATH
 * often lacks, so look there before falling back to PATH.
 */
export function findCelld(home = homedir()): string {
  const installed = join(home, ".local", "bin", "celld");
  return existsSync(installed) ? installed : "celld";
}

/** The version in `celld --version`'s output ("celld X.Y.Z"). */
export function celldVersionOf(output: string): string {
  return /\bcelld (\d+\.\d+\.\d+\S*)/.exec(output)?.[1] ?? "";
}

/** The driver, and a project's main, as the single module celld runs. */
export async function bundleDriver(runtime: string, projectMain?: string, define: { [name: string]: string } = {}): Promise<string> {
  const driver = JSON.stringify(join(runtime, "workerd-worker.mjs"));
  const contents = projectMain === undefined ? `export { default } from ${driver};\n` : [
    `import * as project from ${JSON.stringify(projectMain)};`,
    `export * from ${JSON.stringify(projectMain)};`,
    `export { default } from ${driver};`,
    "globalThis.worker = project.default;",
    "",
  ].join("\n");
  const result = await build({
    stdin: { contents, resolveDir: runtime, loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["browser", "module", "main"],
    alias: builtinAliases(),
    external: ["node:*", "cloudflare:*"],
    define,
    target: "es2024",
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

/** A free loopback port: celld dev needs a number, and rejects 0. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** The host's built-in WebSocket as the session channel. */
function channelOf(ws: WebSocket): WsChannel {
  return {
    send: (text) => ws.send(text),
    onMessage: (listener) => ws.addEventListener("message", (event) => listener(String(event.data))),
    onClose: (listener) => ws.addEventListener("close", () => listener()),
    close() {
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/**
 * Kills celld dev's own children, which run in their own process groups,
 * then the supervisor itself.
 */
function killTree(child: ChildProcess): void {
  for (const pid of childPids(child.pid ?? -1)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone already.
    }
  }
  child.kill("SIGKILL");
}

/** Starts tried when a port is taken (see CelldHost.start). */
const PORT_ATTEMPTS = 3;

/** The driver on `celld dev`. */
class CelldHost implements WorkerHost {
  readonly runtime: string;
  readonly project: string | undefined;
  readonly channel: WsChannel;
  readonly #child: ChildProcess;

  private constructor(child: ChildProcess, channel: WsChannel, runtime: string, project: string | undefined) {
    this.#child = child;
    this.channel = channel;
    this.runtime = runtime;
    this.project = project;
  }

  /**
   * celld dev, retried when a port is taken: both its --port (from
   * freePort) and its node's own listener are picked free and bound later,
   * so another process can take one in between (#54).
   */
  static async start(cwd: string, projectConfig: string | null, executable?: string): Promise<CelldHost> {
    for (let attempt = 1;; attempt++) {
      try {
        return await CelldHost.#start(cwd, projectConfig, executable);
      } catch (err) {
        if (attempt >= PORT_ATTEMPTS || !(err instanceof Error && /Address already in use/.test(err.message))) throw err;
      }
    }
  }

  static async #start(cwd: string, projectConfig: string | null, executable?: string): Promise<CelldHost> {
    const celld = executable ?? findCelld();
    const version = celldVersionOf(execFileSync(celld, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    const source = await runtimeDir(new URL("../runtime/", import.meta.url).href);
    let project: CdpParams | null = null;
    let dir: string;
    if (projectConfig !== null) {
      if (projectConfig.endsWith(".toml")) throw new Error("celld reads wrangler.jsonc or wrangler.json, not wrangler.toml");
      const parsed = parseJsonc(readFileSync(projectConfig, "utf8"));
      if (!isRecord(parsed) || Array.isArray(parsed)) throw new Error(`${projectConfig} is not an object`);
      project = parsed;
      dir = join(dirname(projectConfig), ".celld", "cdp-kernel");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } else {
      dir = mkdtempSync(join(tmpdir(), "cdpk-celld-"));
    }
    const main = project && typeof project.main === "string" ? resolve(dirname(projectConfig ?? cwd), project.main) : undefined;
    const define: { [name: string]: string } = {};
    if (project && isRecord(project.define)) {
      for (const [name, value] of Object.entries(project.define)) {
        if (typeof value !== "string") throw new Error(`define.${name} in ${projectConfig} must be a string`);
        define[name] = value;
      }
    }
    const token = randomBytes(32).toString("hex");
    // 0600: the config carries this launch's token.
    writeFileSync(join(dir, "driver.mjs"), await bundleDriver(source, main, define));
    writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify(celldConfig(project, { token, meta: cellMeta(cwd) }), null, 2), {
      mode: 0o600,
    });

    const port = await freePort();
    const child = spawn(celld, ["dev", dir, "--host", "127.0.0.1", "--port", String(port), "--no-watch"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const removeFiles = () => {
      if (projectConfig === null) rmSync(dir, { recursive: true, force: true });
      else for (const name of ["driver.mjs", "wrangler.jsonc"]) rmSync(join(dir, name), { force: true });
    };
    child.once("exit", removeFiles);
    killOnExit(child, () => {
      killTree(child);
      removeFiles();
    }, { dir: projectConfig === null ? dir : undefined });
    // Cell output is captured in the driver; celld's own lines go to the
    // server log.
    // `early` keeps that output for a startup error only, and stops growing
    // once the session is open.
    let early = "";
    let starting = true;
    const log = (chunk: Buffer) => {
      if (starting) early += chunk.toString();
      process.stderr.write(`[cdp-kernel celld] ${chunk}`);
    };
    child.stdout?.on("data", log);
    child.stderr?.on("data", log);
    const exited = new Promise<never>((_, reject) => {
      child.once("error", reject);
      // On close, not exit, so its last output is in the message.
      child.once("close", (code) => reject(new Error(`celld exited (${code}) before it was ready:\n${early}`)));
    });
    exited.catch(() => {});

    const url = `127.0.0.1:${port}/?token=${token}`;
    const ready = (async () => {
      // The driver answers 426 to a plain request once celld serves it.
      for (let i = 0;; i++) {
        const status = await fetch(`http://${url}`).then((r) => r.status, () => 0);
        if (status === 426) break;
        if (i >= 600) throw new Error(`celld never served the driver (last status ${status}):\n${early}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      const ws = new WebSocket(`ws://${url}`);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("the session WebSocket didn't open")), { once: true });
      });
      return channelOf(ws);
    })();
    try {
      const host = new CelldHost(child, await Promise.race([ready, exited]), `celld ${version}`.trim(), projectConfig ?? undefined);
      // Its server, in its own process group, outlives a SIGKILLed celld dev.
      for (const pid of childPids(child.pid ?? -1)) reapWith(pid, child);
      starting = false;
      early = "";
      return host;
    } catch (err) {
      killTree(child);
      throw err;
    }
  }

  /**
   * celld dev's graceful stop waits for the app, which a busy cell never
   * lets go, and its node runs in its own process group. So a forced stop
   * kills the node, then the supervisor; a graceful one falls back to that.
   */
  stop(now: boolean): void {
    if (now) return killTree(this.#child);
    this.#child.kill("SIGTERM");
    setTimeout(() => {
      if (this.#child.exitCode === null && this.#child.signalCode === null) killTree(this.#child);
    }, 3000).unref();
  }

  onExit(listener: (code: number | null) => void): void {
    this.#child.once("exit", listener);
  }
}

/**
 * A celld target. In a celld project its bindings come along; a project
 * that can't load is reported in the first cell, and the driver runs alone.
 */
export async function launchCelld(
  events: TargetEvents,
  options: { cwd?: string; executable?: string } = {},
): Promise<WorkerdTarget> {
  const cwd = options.cwd ?? process.cwd();
  const project = findWranglerConfig(cwd);
  let host: CelldHost | null = null;
  let notice: string | undefined;
  if (project !== null) {
    try {
      host = await CelldHost.start(cwd, project, options.executable);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      notice = `[cdp-kernel] couldn't load the celld project at ${project}: ${reason}; running without its bindings`;
    }
  }
  host ??= await CelldHost.start(cwd, null, options.executable);
  return await WorkerdTarget.open(host, cwd, events, "celld", notice);
}
