// The workerd target (#8). Cells run inside a driver Worker
// (runtime/workerd-worker.mjs): outside a request workerd has no IoContext,
// so timers, fetch and randomness throw. The host opens one WebSocket
// session to the driver and sends every request over it as a JSON message;
// all of them run in that session request's IoContext, so I/O objects and
// pending work carry over between cells (#26). Console output, iopub
// messages and replies come back the same way. Cells are transformed as for
// Bun (transformCellForEval).
//
// Outside a Workers project the host serves the driver on a workerd of its
// own, behind a Unix socket in a private temporary directory, with a
// per-launch token (RawWorkerd). In a project it uses the project's
// Miniflare instead, for its bindings (src/workers-project.ts).
//
// workerd can't load modules at runtime beyond its builtins, so whatever
// else a cell imports is bundled here with esbuild and sent with the cell.

import { Buffer } from "node:buffer";
import process from "node:process";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { asEvaluateResult, type CdpParams, type EvaluateResult, type RemoteObject } from "./cdp.ts";
import { transformCellForEval } from "./transform.ts";
import { runtimeDir } from "./package.ts";
import { killOnExit } from "./children.ts";
import { Interrupted, isTargetMessage, type KernelTarget, type TargetEvents } from "./target.ts";
import { withStartTimeout } from "./target-api.ts";
import { connectUnixWebSocket, type WsChannel } from "./ws-client.ts";
import { findWranglerConfig, startMiniflare } from "./workers-project.ts";
import { ensureInstalledAsync, findLockFile, jsrToNpm, parsePackageSpecifier } from "../runtime/node-hooks.mjs";

/** The driver Worker's modules; the first is its main module. */
export const WORKER_MODULES = ["workerd-worker.mjs", "display.mjs", "comm.mjs", "widget.mjs", "evaluator.mjs", "introspect.mjs"];

/** See BunTarget: how long an interrupted cell has to show it isn't busy. */
export const INTERRUPT_GRACE_MS = 500;

export function restartNote(runtime: string): string {
  return `[cdp-kernel] ${runtime} was busy and can't be interrupted in place, so it was stopped; ` +
    "it restarts on the next cell, without the earlier cells' state";
}

export const RESTART_NOTE = restartNote("workerd");

// nodejs_compat is on by default from this compatibility date, and workerd
// warns when it's also listed.
const NODEJS_COMPAT_DEFAULT = "2026-08-04";

const BUILTIN = /^(?:node|cloudflare|workerd):/;

export function workerdConfig(
  { socket, compatibilityDate }: { socket: string; compatibilityDate: string },
): string {
  const modules = WORKER_MODULES.map((name) => `(name = ${JSON.stringify(name)}, esModule = embed ${JSON.stringify(name)})`);
  const flags = compatibilityDate < NODEJS_COMPAT_DEFAULT ? `["nodejs_compat"]` : "[]";
  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "cdpk", worker = .driver),
    (name = "internet", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
  ],
  sockets = [(name = "host", address = ${JSON.stringify(`unix:${socket}`)}, http = (), service = "cdpk")],
);

const driver :Workerd.Worker = (
  modules = [
    ${modules.join(",\n    ")},
  ],
  compatibilityDate = ${JSON.stringify(compatibilityDate)},
  compatibilityFlags = ${flags},
  globalOutbound = "internet",
  bindings = [
    (name = "UNSAFE", unsafeEval = void),
    (name = "TOKEN", fromEnvironment = "CDPK_TOKEN"),
    (name = "META", fromEnvironment = "CDPK_META"),
  ],
);
`;
}

/**
 * A Workers project has workerd in its node_modules (wrangler and miniflare
 * depend on it), so look there first, from the notebook's directory up;
 * otherwise use the one on PATH.
 */
export function findWorkerd(cwd: string): string {
  for (let dir = cwd;; dir = dirname(dir)) {
    const bin = join(dir, "node_modules", ".bin", process.platform === "win32" ? "workerd.cmd" : "workerd");
    if (existsSync(bin)) return bin;
    if (dirname(dir) === dir) return "workerd";
  }
}

/** "workerd 2026-10-15" -> "2026-10-15": the newest date it supports. */
export function compatibilityDateOf(versionOutput: string): string {
  const m = /\b(\d{4}-\d{2}-\d{2})\b/.exec(versionOutput);
  if (!m) throw new Error(`can't read a date from workerd --version: ${versionOutput.trim()}`);
  return m[1];
}

/** The literal specifiers a transformed cell imports, in order. */
export function importSpecifiers(script: string): string[] {
  const found = new Set<string>();
  for (const m of script.matchAll(/__cdpk\.import\(("(?:[^"\\]|\\.)*")/g)) {
    const specifier: unknown = JSON.parse(m[1]);
    if (typeof specifier === "string") found.add(specifier);
  }
  return [...found];
}

const NODE_BUILTINS = builtinModules.filter((name) => !name.startsWith("_"));

/**
 * Bundles `specifier`, as imported from `cwd`, into global code whose value
 * is a promise of the module's namespace. npm: and jsr: install into the
 * npm cache, as on a Node target. Builtins stay external and are handed to
 * the bundle as `require` (workerd-worker.mjs's requireFor). A specifier
 * that can't be bundled becomes code that throws when imported, so the
 * error appears in the cell.
 */
export async function bundleModule(specifier: string, cwd: string): Promise<string> {
  try {
    let entry = specifier;
    let resolveDir = cwd;
    const pkg = specifier.startsWith("npm:")
      ? parsePackageSpecifier(specifier.slice(4))
      : specifier.startsWith("jsr:")
      ? jsrToNpm(specifier.slice(4))
      : null;
    if (pkg) {
      // Async: a sync install would stall the heartbeat and interrupts (#149).
      const { dir, alias } = await ensureInstalledAsync(pkg, "npm", { lockFile: findLockFile(cwd) });
      entry = alias + pkg.subpath;
      resolveDir = dir;
    }
    const result = await build({
      stdin: { contents: `import * as ns from ${JSON.stringify(entry)};\nexport { ns };\n`, resolveDir, loader: "js" },
      bundle: true,
      write: false,
      format: "iife",
      globalName: "__cdpk_bundle",
      platform: "browser",
      // What wrangler resolves for Workers.
      conditions: ["workerd", "worker", "browser"],
      mainFields: ["browser", "module", "main"],
      external: ["node:*", "cloudflare:*", "workerd:*", ...NODE_BUILTINS],
      target: "esnext",
      metafile: true,
      logLevel: "silent",
    });
    const externals = new Set<string>();
    for (const output of Object.values(result.metafile.outputs)) {
      for (const imported of output.imports) if (imported.external) externals.add(imported.path);
    }
    return `(async () => { const require = await __cdpk.requireFor(${JSON.stringify([...externals])});\n` +
      `${result.outputFiles[0].text}\nreturn __cdpk_bundle.ns; })()`;
  } catch (err) {
    // esbuild's failures carry structured errors; their text reads best.
    const errors = (err as { errors?: unknown }).errors;
    const texts = Array.isArray(errors) ? errors.map((e: { text?: unknown }) => e?.text).filter((t) => typeof t === "string") : [];
    const message = texts.length > 0 ? texts.join("; ") : err instanceof Error ? err.message : String(err);
    return `Promise.reject(new TypeError(${JSON.stringify(`Cannot import "${specifier}": ${message}`)}))`;
  }
}

/** Rejects a request whose reply the host no longer waits for. */
class Abandoned extends Error {}

function isRecord(value: unknown): value is CdpParams {
  return typeof value === "object" && value !== null;
}

/** What import.meta says in a cell: the notebook's directory, not workerd's. */
export function cellMeta(cwd: string): { url: string; dirname: string; filename: string } {
  const replUrl = new URL("$cdpk$repl.mjs", pathToFileURL(cwd.endsWith("/") ? cwd : cwd + "/"));
  return { url: replUrl.href, dirname: cwd, filename: join(cwd, "$cdpk$repl.mjs") };
}

/**
 * How the target reaches its driver Worker: a workerd of its own
 * (RawWorkerd, below), or a Workers project's Miniflare
 * (src/workers-project.ts), which adds the project's bindings.
 */
export interface WorkerHost {
  /** The runtime's name for the banner: workerd's date, or Miniflare's version. */
  readonly runtime: string;
  /** The wrangler config whose bindings the driver has, if any. */
  readonly project?: string;
  /** The open session with the driver. */
  readonly channel: WsChannel;
  /** Stops the runtime; `now` even while a cell is busy. */
  stop(now: boolean): void;
  onExit(listener: (code: number | null) => void): void;
}

const WORKERD_DIR_PREFIX = "cdpk-workerd-";
/** In each workerd directory: `{ host, workerd }` pids. */
const OWNER_FILE = "owner.json";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}

/** Whether `pid` is still the workerd serving `dir`, not a reused pid. */
function isWorkerdIn(pid: number, dir: string): boolean {
  try {
    if (process.platform === "linux") return readlinkSync(`/proc/${pid}/cwd`) === dir;
    const args = execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
    return /workerd/.test(args) && args.includes("config.capnp");
  } catch {
    return false;
  }
}

/**
 * Removes workerd directories under `root` whose kernel has died without
 * cleaning up (SIGKILL runs no exit hook), killing their workerd if it's
 * still running (#220).
 */
export function sweepStaleWorkerdDirs(root = tmpdir()): void {
  let names: string[];
  try {
    names = readdirSync(root).filter((name) => name.startsWith(WORKERD_DIR_PREFIX));
  } catch {
    return;
  }
  for (const name of names) {
    const dir = join(root, name);
    let owner: { host?: unknown; workerd?: unknown };
    try {
      owner = JSON.parse(readFileSync(join(dir, OWNER_FILE), "utf8"));
    } catch {
      continue; // Another user's, from before owner files, or being set up.
    }
    if (typeof owner.host !== "number" || pidAlive(owner.host)) continue;
    if (typeof owner.workerd === "number" && isWorkerdIn(owner.workerd, dir)) {
      try {
        process.kill(owner.workerd, "SIGKILL");
      } catch {
        // Gone already.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The driver on a workerd of its own, behind a Unix socket. */
export class RawWorkerd implements WorkerHost {
  readonly runtime: string;
  readonly channel: WsChannel;
  readonly #child: ChildProcess;

  private constructor(child: ChildProcess, channel: WsChannel, runtime: string) {
    this.#child = child;
    this.channel = channel;
    this.runtime = runtime;
  }

  static async start(cwd: string, executable?: string): Promise<RawWorkerd> {
    const workerd = executable ?? findWorkerd(cwd);
    const compatibilityDate = compatibilityDateOf(execFileSync(workerd, ["--version"], { encoding: "utf8" }));
    const source = await runtimeDir(new URL("../runtime/", import.meta.url).href);
    // mkdtemp makes the directory 0700: only this user reaches the socket,
    // and the token stops anything else running as them by accident.
    sweepStaleWorkerdDirs();
    const dir = mkdtempSync(join(tmpdir(), WORKERD_DIR_PREFIX));
    writeFileSync(join(dir, OWNER_FILE), JSON.stringify({ host: process.pid }));
    const socket = join(dir, "sock");
    for (const name of WORKER_MODULES) copyFileSync(join(source, name), join(dir, name));
    writeFileSync(join(dir, "config.capnp"), workerdConfig({ socket, compatibilityDate }));
    const token = randomBytes(32).toString("hex");
    const env: Record<string, string | undefined> = { ...process.env, CDPK_TOKEN: token, CDPK_META: JSON.stringify(cellMeta(cwd)) };
    // --experimental: the UnsafeEval binding.
    const child = spawn(workerd, ["serve", "config.capnp", "--experimental"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env });
    child.once("exit", () => rmSync(dir, { recursive: true, force: true }));
    if (child.pid !== undefined) writeFileSync(join(dir, OWNER_FILE), JSON.stringify({ host: process.pid, workerd: child.pid }));
    killOnExit(child, () => {
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }, { dir });

    // Cell output is captured inside the Worker; what workerd itself prints
    // (its own warnings, errors from background work) goes to the server log.
    // `early` keeps that output for a startup error only, and stops growing
    // once the session is open.
    let early = "";
    let starting = true;
    const log = (chunk: Buffer) => {
      if (starting) early += chunk.toString();
      process.stderr.write(`[cdp-kernel workerd] ${chunk}`);
    };
    child.stdout?.on("data", log);
    child.stderr?.on("data", log);
    const exited = new Promise<never>((_, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`workerd exited (${code}) before it was ready:\n${early}`)));
    });
    exited.catch(() => {});

    const ready = (async () => {
      for (let i = 0;; i++) {
        try {
          return await connectUnixWebSocket(socket, { headers: { "x-cdpk-token": token } });
        } catch (err) {
          if (i >= 200) throw err;
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    })();
    try {
      const host = new RawWorkerd(child, await withStartTimeout(Promise.race([ready, exited]), "workerd"), compatibilityDate);
      starting = false;
      early = "";
      return host;
    } catch (err) {
      child.kill();
      throw err;
    }
  }

  stop(now: boolean): void {
    if (now) {
      this.#child.kill("SIGKILL");
      return;
    }
    this.#child.kill("SIGTERM");
    // A busy isolate keeps workerd's event loop from ever seeing SIGTERM (#128).
    setTimeout(() => {
      if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill("SIGKILL");
    }, 3000).unref();
  }

  onExit(listener: (code: number | null) => void): void {
    this.#child.once("exit", listener);
  }
}

type Pending = { resolve: (reply: CdpParams) => void; reject: (err: Error) => void };

/** A runtime that runs the driver Worker: workerd, or celld (src/celld-target.ts). */
export type WorkersRuntime = "workerd" | "celld";

export class WorkerdTarget implements KernelTarget {
  readonly runtime: WorkersRuntime;
  readonly versions: { runtime: string; engine: string };
  notice: string | undefined;
  readonly transform = transformCellForEval;
  readonly #host: WorkerHost;
  readonly #cwd: string;
  readonly #events: TargetEvents;
  /** Specifiers whose bundle this workerd has been sent. */
  readonly #sent = new Set<string>();
  readonly #pending = new Map<number, Pending>();
  /** Requests that interrupt() abandons when the driver can still answer. */
  readonly #interruptible = new Set<number>();
  #nextId = 0;
  #interrupted = false;
  #stopNote: string | undefined;
  #exitedOnce = false;

  private constructor(host: WorkerHost, cwd: string, events: TargetEvents, runtime: WorkersRuntime) {
    this.runtime = runtime;
    this.#host = host;
    this.versions = { runtime: host.runtime, engine: "V8" };
    this.#cwd = cwd;
    this.#events = events;
    host.channel.onMessage((text) => this.#receive(text));
    host.channel.onClose(() => this.#exited(null));
    host.onExit((code) => this.#exited(code));
  }

  /**
   * In a Workers project (a wrangler config at or above `cwd`), the
   * project's own Miniflare runs the driver with the project's bindings;
   * otherwise a workerd of its own does (#26).
   */
  static async launch(
    events: TargetEvents,
    options: { cwd?: string; executable?: string; startTimeoutMs?: number } = {},
  ): Promise<WorkerdTarget> {
    const cwd = options.cwd ?? process.cwd();
    const project = findWranglerConfig(cwd);
    let host: WorkerHost | null = null;
    let notice: string | undefined;
    if (project !== null) {
      try {
        host = await startMiniflare(project, cwd, options.startTimeoutMs);
      } catch (err) {
        // Like a broken deno.json (#13): say why in the first cell, and run
        // without the project.
        const reason = err instanceof Error ? err.message : String(err);
        notice = `[cdp-kernel] couldn't load the Workers project at ${project}: ${reason}; running without its bindings`;
      }
    }
    host ??= await RawWorkerd.start(cwd, options.executable);
    return await WorkerdTarget.open(host, cwd, events, "workerd", { notice, startTimeoutMs: options.startTimeoutMs });
  }

  /**
   * A target over a started host's session. `notice` (a project that
   * failed to load) is replaced by the bindings when the host has a project.
   */
  static async open(
    host: WorkerHost,
    cwd: string,
    events: TargetEvents,
    runtime: WorkersRuntime,
    options: { notice?: string; startTimeoutMs?: number } = {},
  ): Promise<WorkerdTarget> {
    const target = new WorkerdTarget(host, cwd, events, runtime);
    let notice = options.notice;
    try {
      // A driver that never answers is stopped (#336).
      const { v8, bindings, worker } = await withStartTimeout(target.#request("info"), `the ${runtime} driver`, options.startTimeoutMs);
      if (typeof v8 === "string" && v8) target.versions.engine = `V8 ${v8}`;
      if (host.project !== undefined) {
        const names = Array.isArray(bindings) ? bindings.map(String).sort().join(", ") : "";
        notice = `[cdp-kernel] Workers project ${host.project}: env has ${names || "no bindings"}` +
          (worker === true ? "; worker is its default export" : "");
      }
    } catch (err) {
      target.kill();
      throw err;
    }
    target.notice = notice;
    return target;
  }

  #receive(text: string): void {
    const msg: unknown = JSON.parse(text);
    if (isRecord(msg) && msg.kind === "stream") {
      this.#events.stream(msg.name === "stderr" ? "stderr" : "stdout", String(msg.text));
    } else if (isTargetMessage(msg)) {
      this.#events.message(msg);
    } else if (isRecord(msg) && msg.kind === "reply") {
      const id = Number(msg.id);
      const pending = this.#pending.get(id);
      if (!pending) return; // abandoned
      this.#pending.delete(id);
      this.#interruptible.delete(id);
      if (typeof msg.failure === "string") pending.reject(new Error(msg.failure));
      else pending.resolve(msg);
    }
  }

  #exited(code: number | null): void {
    if (this.#exitedOnce) return;
    this.#exitedOnce = true;
    // The exit (and its note) is reported before the requests it cut off
    // fail, so the note lands in the interrupted cell's output.
    this.#events.exit(code, this.#stopNote);
    for (const pending of this.#pending.values()) pending.reject(new Abandoned(`workerd exited (${code})`));
    this.#pending.clear();
  }

  #request(op: string, params: CdpParams = {}, interruptible = false): Promise<CdpParams> {
    // The channel drops writes after it closes, so nothing would answer.
    if (this.#exitedOnce) return Promise.reject(new Abandoned("the workerd session is closed"));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      if (interruptible) this.#interruptible.add(id);
      try {
        this.#host.channel.send(JSON.stringify({ id, op, ...params }));
      } catch {
        this.#pending.delete(id);
        reject(new Abandoned("the workerd session is closed"));
      }
    });
  }

  async #interruptibly(op: string, params: CdpParams, what: string): Promise<CdpParams> {
    this.#interrupted = false;
    try {
      return await this.#request(op, params, true);
    } catch (err) {
      if (err instanceof Abandoned || this.#interrupted) throw new Interrupted(`${what} interrupted`);
      throw err;
    }
  }

  async evaluate(script: string): Promise<EvaluateResult> {
    const modules: Record<string, string> = {};
    for (const specifier of importSpecifiers(script)) {
      if (BUILTIN.test(specifier) || this.#sent.has(specifier)) continue;
      modules[specifier] = await bundleModule(specifier, this.#cwd);
      // A failed bundle is rebuilt next time, after the user fixes it.
      if (!modules[specifier].startsWith("Promise.reject(")) this.#sent.add(specifier);
    }
    const { failedModules, ...reply } = await this.#interruptibly("eval", { code: script, modules }, "Execution");
    // A module that threw while loading is rebuilt for its next import (#147).
    if (Array.isArray(failedModules)) for (const specifier of failedModules) this.#sent.delete(specifier);
    return asEvaluateResult(reply);
  }

  /**
   * A cell that's waiting on something leaves the driver free: it answers a
   * ping, and the cell is abandoned with the session intact (its pending
   * work still runs, as on Bun). A busy cell can't be reached, so workerd is
   * stopped and restarts on the next cell.
   */
  async interrupt(): Promise<void> {
    this.#interrupted = true;
    const running = [...this.#interruptible];
    const answered = await Promise.race([
      this.#request("ping").then(() => true, () => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), INTERRUPT_GRACE_MS)),
    ]);
    if (answered) {
      for (const id of running) {
        this.#pending.get(id)?.reject(new Abandoned("interrupted"));
        this.#pending.delete(id);
        this.#interruptible.delete(id);
      }
      return;
    }
    this.#stopNote = restartNote(this.runtime);
    this.#host.stop(true);
  }

  /** Output arrives on the session before the reply it precedes. */
  flush(): Promise<void> {
    return Promise.resolve();
  }

  async broadcastResult(executionCount: number, result: RemoteObject): Promise<void> {
    if (result.objectId === undefined) return;
    await this.#request("broadcast", { count: executionCount, handle: result.objectId });
  }

  async dispatchComm(
    msgType: string,
    content: CdpParams,
    metadata: CdpParams,
    buffers: Uint8Array[],
  ): Promise<{ handled: boolean } | { error: { name: string; message: string; stack: string } }> {
    const reply = await this.#interruptibly("comm", {
      msgType,
      content,
      metadata,
      buffers: buffers.map((b) => Buffer.from(b).toString("base64")),
    }, "Comm handler");
    if (isRecord(reply.error)) {
      const { name, message, stack } = reply.error;
      return { error: { name: String(name), message: String(message), stack: String(stack) } };
    }
    return { handled: reply.handled === true };
  }

  async describeError(exception: RemoteObject): Promise<{ name: string; message: string; stack: string }> {
    if (exception.objectId === undefined) return { name: "Error", message: exception.description ?? "", stack: "" };
    const { value } = await this.#request("describe", { handle: exception.objectId });
    return JSON.parse(typeof value === "string" ? value : '{"name":"Error","message":"","stack":""}');
  }

  async propertyNames(expression: string): Promise<string[]> {
    const reply = await this.#request("props", { expr: expression }).catch(() => null);
    return Array.isArray(reply?.names) ? reply.names.filter((n): n is string => typeof n === "string") : [];
  }

  /** Resolved by property descriptor in the driver, so nothing runs (#10). */
  async inspect(path: string, detail: number): Promise<string | null> {
    const reply = await this.#request("inspect", { path, detail }).catch(() => null);
    return typeof reply?.text === "string" ? reply.text : null;
  }

  /** None: top-level declarations here are properties of globalThis. */
  lexicalNames(): Promise<string[]> {
    return Promise.resolve([]);
  }

  /** Never asked for: prompt() in workerd answers null without asking. */
  replyInput(): void {}

  kill(): void {
    // workerd's graceful shutdown waits for open connections, the session
    // included, so close it first.
    this.#host.channel.close();
    this.#host.stop(false);
  }
}
