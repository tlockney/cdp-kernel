// The workerd target (#8). Cells run inside requests to a driver Worker
// (runtime/workerd-worker.mjs): outside a request workerd has no IoContext,
// so timers, fetch and randomness throw. The host generates a workerd config
// for the driver, serves it on a Unix socket in a private temporary
// directory, and sends each request as an HTTP POST carrying a per-launch
// token. Responses stream back console output and iopub messages, then the
// reply. Cells are transformed as for Bun (transformCellForEval).
//
// workerd can't load modules at runtime beyond its builtins, so whatever
// else a cell imports is bundled here with esbuild and sent with the cell.

import { Buffer } from "node:buffer";
import process from "node:process";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { CdpParams, EvaluateResult, RemoteObject } from "./cdp.ts";
import { transformCellForEval } from "./transform.ts";
import { runtimeDir } from "./package.ts";
import { Interrupted, isTargetMessage, type KernelTarget, type TargetEvents } from "./target.ts";
import { ensureInstalled, jsrToNpm, parsePackageSpecifier } from "../runtime/node-hooks.mjs";

/** The driver Worker's modules; the first is its main module. */
export const WORKER_MODULES = ["workerd-worker.mjs", "display.mjs", "comm.mjs", "widget.mjs", "evaluator.mjs"];

/** See BunTarget: how long an interrupted cell has to show it isn't busy. */
export const INTERRUPT_GRACE_MS = 500;

export const RESTART_NOTE =
  "[cdp-kernel] workerd was busy and can't be interrupted in place, so it was stopped; " +
  "it restarts on the next cell, without the earlier cells' state";

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
      const { dir, alias } = ensureInstalled(pkg);
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

export const HUNG_MESSAGE =
  "workerd canceled this cell: it was waiting on a promise that nothing pending (no timer or I/O) " +
  "could settle, which workerd treats as a hung request. Earlier cells' state is kept.";

/** workerd itself canceled the request (see HUNG_MESSAGE). */
class HungRequest extends Error {
  constructor() {
    super(HUNG_MESSAGE);
  }
}

function isRecord(value: unknown): value is CdpParams {
  return typeof value === "object" && value !== null;
}

export class WorkerdTarget implements KernelTarget {
  readonly runtime = "workerd";
  readonly versions = { runtime: "", engine: "" };
  readonly transform = transformCellForEval;
  readonly #child: ChildProcess;
  readonly #dir: string;
  readonly #socket: string;
  readonly #token: string;
  readonly #cwd: string;
  readonly #events: TargetEvents;
  /** Specifiers whose bundle this workerd has been sent. */
  readonly #sent = new Set<string>();
  /** Each request's controller, and how to fail it once workerd is gone. */
  readonly #inFlight = new Map<AbortController, (err: Error) => void>();
  #interrupted = false;
  #stopNote: string | undefined;

  private constructor(child: ChildProcess, dir: string, token: string, cwd: string, events: TargetEvents) {
    this.#child = child;
    this.#dir = dir;
    this.#socket = join(dir, "sock");
    this.#token = token;
    this.#cwd = cwd;
    this.#events = events;
  }

  static async launch(events: TargetEvents, options: { cwd?: string; executable?: string } = {}): Promise<WorkerdTarget> {
    const cwd = options.cwd ?? process.cwd();
    const workerd = options.executable ?? findWorkerd(cwd);
    const compatibilityDate = compatibilityDateOf(execFileSync(workerd, ["--version"], { encoding: "utf8" }));
    const source = await runtimeDir(new URL("../runtime/", import.meta.url).href);
    // mkdtemp makes the directory 0700: only this user reaches the socket,
    // and the token stops anything else running as them by accident.
    const dir = mkdtempSync(join(tmpdir(), "cdpk-workerd-"));
    for (const name of WORKER_MODULES) copyFileSync(join(source, name), join(dir, name));
    writeFileSync(join(dir, "config.capnp"), workerdConfig({ socket: join(dir, "sock"), compatibilityDate }));
    const token = randomBytes(32).toString("hex");
    const cwdUrl = pathToFileURL(cwd.endsWith("/") ? cwd : cwd + "/");
    const replUrl = new URL("$cdpk$repl.mjs", cwdUrl);
    const meta = { url: replUrl.href, dirname: cwd, filename: join(cwd, "$cdpk$repl.mjs") };
    const env: Record<string, string | undefined> = { ...process.env, CDPK_TOKEN: token, CDPK_META: JSON.stringify(meta) };
    // --experimental: the UnsafeEval binding.
    const child = spawn(workerd, ["serve", "config.capnp", "--experimental"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env });
    const target = new WorkerdTarget(child, dir, token, cwd, events);

    // Cell output is captured inside the Worker; what workerd itself prints
    // (its own warnings, errors from background work) goes to the server log.
    let early = "";
    const log = (chunk: Buffer) => {
      early += chunk.toString();
      process.stderr.write(`[cdp-kernel workerd] ${chunk}`);
    };
    child.stdout?.on("data", log);
    child.stderr?.on("data", log);
    const exited = new Promise<never>((_, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`workerd exited (${code}) before it was ready:\n${early}`)));
    });
    exited.catch(() => {});
    child.once("exit", (code) => target.#exited(code));

    const ready = (async () => {
      for (let i = 0;; i++) {
        try {
          return await target.#get();
        } catch (err) {
          if (i >= 200) throw err;
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    })();
    try {
      const { v8 } = await Promise.race([ready, exited]);
      Object.assign(target.versions, { runtime: compatibilityDate, engine: typeof v8 === "string" && v8 ? `V8 ${v8}` : "V8" });
    } catch (err) {
      target.kill();
      throw err;
    }
    return target;
  }

  #exited(code: number | null): void {
    rmSync(this.#dir, { recursive: true, force: true });
    // The exit (and its note) is reported before the requests it cut off
    // fail, so the note lands in the interrupted cell's output.
    this.#events.exit(code, this.#stopNote);
    for (const fail of this.#inFlight.values()) fail(new Abandoned(`workerd exited (${code})`));
    this.#inFlight.clear();
  }

  #get(): Promise<CdpParams> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ socketPath: this.#socket, path: "/", method: "GET", headers: { "x-cdpk-token": this.#token } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          const parsed: unknown = res.statusCode === 200 ? JSON.parse(body) : null;
          if (isRecord(parsed)) resolve(parsed);
          else reject(new Error(`workerd answered ${res.statusCode}`));
        });
      });
      req.on("error", reject);
      req.end();
    });
  }

  /** POSTs a request; streamed output is delivered as it arrives. */
  #request(op: string, params: CdpParams = {}): Promise<CdpParams> {
    const controller = new AbortController();
    return new Promise<CdpParams>((resolve, reject) => {
      this.#inFlight.set(controller, reject);
      // While workerd is being stopped, a broken connection is left for
      // #exited to report.
      const fail = (err: Error) => {
        if (this.#stopNote !== undefined) return;
        if (controller.signal.aborted) reject(new Abandoned(op));
        // workerd cancels a request whose code waits on something that can
        // never settle (no timer or I/O pending).
        else if (/^(?:aborted|socket hang up)$/.test(err.message)) reject(new HungRequest());
        else reject(err);
      };
      let reply: CdpParams | null = null;
      const req = httpRequest(
        {
          socketPath: this.#socket,
          path: "/",
          method: "POST",
          headers: { "x-cdpk-token": this.#token, "content-type": "application/json" },
          signal: controller.signal,
        },
        (res) => {
          let buffer = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buffer += chunk;
            for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
              const msg: unknown = JSON.parse(buffer.slice(0, nl));
              buffer = buffer.slice(nl + 1);
              if (isRecord(msg) && msg.kind === "stream") {
                this.#events.stream(msg.name === "stderr" ? "stderr" : "stdout", String(msg.text));
              } else if (isTargetMessage(msg)) {
                this.#events.message(msg);
              } else if (isRecord(msg) && msg.kind === "reply") {
                reply = msg;
              }
            }
          });
          res.on("end", () => {
            if (reply === null) fail(new Error("aborted"));
            else if (typeof reply.failure === "string") reject(new Error(reply.failure));
            else resolve(reply);
          });
          res.on("error", fail);
        },
      );
      req.on("error", fail);
      req.end(JSON.stringify({ op, ...params }));
    }).finally(() => this.#inFlight.delete(controller));
  }

  async #interruptible(op: string, params: CdpParams, what: string): Promise<CdpParams> {
    this.#interrupted = false;
    try {
      return await this.#request(op, params);
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
    try {
      return (await this.#interruptible("eval", { code: script, modules }, "Execution")) as unknown as EvaluateResult;
    } catch (err) {
      // Reported like any error the cell raised.
      if (err instanceof HungRequest) {
        return { result: { type: "undefined" }, exceptionDetails: { text: err.message, lineNumber: 0, columnNumber: 0 } };
      }
      throw err;
    }
  }

  /**
   * Aborting a request makes workerd cancel what it was waiting on, with
   * the isolate and its globals intact. A busy cell can't be reached, so
   * workerd is stopped and restarts on the next cell (see BunTarget).
   */
  async interrupt(): Promise<void> {
    this.#interrupted = true;
    const running = [...this.#inFlight.keys()];
    const answered = await Promise.race([
      this.#request("ping").then(() => true, () => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), INTERRUPT_GRACE_MS)),
    ]);
    if (answered) {
      for (const controller of running) controller.abort();
      return;
    }
    this.#stopNote = RESTART_NOTE;
    this.#child.kill("SIGKILL");
  }

  /** Output arrives on each request's own response, before its reply. */
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
    const reply = await this.#interruptible("comm", {
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

  /** None: top-level declarations here are properties of globalThis. */
  lexicalNames(): Promise<string[]> {
    return Promise.resolve([]);
  }

  /** Never asked for: prompt() in workerd answers null without asking. */
  replyInput(): void {}

  kill(): void {
    this.#child.kill();
  }
}
