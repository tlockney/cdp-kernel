// A target runtime driven over CDP: the stand-in for Deno's REPL isolate and
// the ops in cli/ops/jupyter.rs. Any runtime whose --inspect speaks CDP and
// can load runtime/bootstrap.mjs works; Node and Deno are wired up here.

import { Buffer } from "node:buffer";
import process from "node:process";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { asEvaluateResult, CdpAbandoned, CdpSession, type CdpParams, type EvaluateResult, type RemoteObject } from "./cdp.ts";
import { type CellTransformOptions, SHIM, transformCell } from "./transform.ts";
import type { DebugChannel } from "./debugger.ts";
import { hostRuntime, isInsideNodeModules, runtimeDir } from "./package.ts";
import { killOnExit } from "./children.ts";

/** Targets driven over CDP. */
export type CdpRuntime = "node" | "deno";
/** Bun, workerd and celld have their own backends: src/bun-target.ts, src/workerd-target.ts, src/celld-target.ts. */
export type RuntimeName = CdpRuntime | "bun" | "workerd" | "celld";

/** What the kernel needs from a target runtime. */
export interface KernelTarget {
  readonly runtime: RuntimeName;
  readonly versions: { runtime: string; engine: string };
  /** Shown once, in the first cell: e.g. which project's bindings loaded. */
  readonly notice?: string;
  /** Turns a cell into the script evaluate() takes. */
  transform(code: string, options: CellTransformOptions): string;
  /** Runs a transformed cell. Rejects with Interrupted after interrupt(). */
  evaluate(script: string): Promise<EvaluateResult>;
  interrupt(): Promise<void>;
  /** Resolves once all output and messages sent so far have been delivered. */
  flush(): Promise<void>;
  broadcastResult(executionCount: number, result: RemoteObject): Promise<void>;
  dispatchComm(
    msgType: string,
    content: CdpParams,
    metadata: CdpParams,
    buffers: Uint8Array[],
  ): Promise<{ handled: boolean } | { error: { name: string; message: string; stack: string } }>;
  describeError(exception: RemoteObject): Promise<{ name: string; message: string; stack: string }>;
  propertyNames(expression: string): Promise<string[]>;
  lexicalNames(): Promise<string[]>;
  /** inspect_request (#10): text describing a dotted path's value, without running anything. */
  inspect(path: string, detail: number): Promise<string | null>;
  /** The Debugger domain, on targets driven over CDP (#18). */
  readonly debug?: DebugChannel;
  replyInput(value: string | null): void;
  kill(): void;
}

const BINDING = "__cdpk_send";
/** How long a target may take from spawn to a usable session. */
const START_TIMEOUT_MS = 60_000;
const MARKER_RE = /\x1b\[cdpk:(\d+)(m?)\]\x1b/;
const MAX_MARKER_LEN = 24;
// Lines the runtimes print to stderr on their own: inspector notices, and
// Deno's npm/jsr "Download https://..." progress (which `deno jupyter`
// sends to the server log rather than the notebook). Each entry is the
// line's start once colour codes are removed.
const INSPECTOR_CHATTER = [
  "Debugger listening on ",
  "Debugger attached.",
  "For help, see: https://nodejs.org/",
  "Visit chrome://inspect",
  "Waiting for the debugger to disconnect",
];
const DENO_CHATTER = [...INSPECTOR_CHATTER, "Download http://", "Download https://"];
const ANSI_SGR = /\x1b\[[0-9;]*m/g;
/** A colour code cut off at the end of a chunk. */
const PARTIAL_SGR = /\x1b(?:\[[0-9;]*)?$/;

export interface LaunchOptions {
  /** Runtime binary; defaults to `deno`, or `node` (this one when hosted by Node). */
  executable?: string;
  /** A Deno target's project config (deno.json), passed as --config. */
  denoConfig?: string;
}

/** `bootstrap` is the local path of runtime/bootstrap.mjs (see runtimeDir). */
export function launchCommand(
  runtime: CdpRuntime,
  bootstrap: string,
  { executable, denoConfig }: LaunchOptions = {},
): { cmd: string; args: string[] } {
  // The CDP WebSocket has no authentication, so its URL must stay private:
  // by default the inspector lists it at /json/list for any local process
  // to read. Publishing it only on stderr, which only this host reads,
  // leaves a random id nobody else can learn (#22).
  const inspect = ["--inspect=127.0.0.1:0", "--inspect-publish-uid=stderr"];
  if (runtime === "deno") {
    // Deno discovers config from the main module's location, which would
    // put npm: imports in BYONM mode against this package's own
    // package.json. `none` gives the global-cache behaviour `deno jupyter`
    // has in a plain directory; --no-lock stops it writing a deno.lock
    // into this package.
    return {
      cmd: executable ?? "deno",
      // In a project, its config (import map, nodeModulesDir, ...) applies
      // instead; --no-lock still keeps the kernel out of the project's lock.
      args: denoConfig === undefined
        ? ["run", "--allow-all", "--node-modules-dir=none", "--no-lock", ...inspect, bootstrap]
        : ["run", "--allow-all", "--config", denoConfig, "--no-lock", ...inspect, bootstrap],
    };
  }
  // Under a Deno host, process.execPath is deno; find node on PATH instead.
  const node = hostRuntime() === "node" ? process.execPath : "node";
  return { cmd: executable ?? node, args: [...inspect, bootstrap] };
}

/**
 * The esbuild binary this host's esbuild runs, for a Node target to compile
 * imported TypeScript Node can't strip (#73); null when it can't be found.
 * Resolved from esbuild's own location, so it's found in a node_modules
 * install and in Deno's npm cache alike.
 */
export function esbuildBinary(
  resolve: (specifier: string) => string = import.meta.resolve,
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  if (process.env.ESBUILD_BINARY_PATH) return process.env.ESBUILD_BINARY_PATH;
  const subpath = platform === "win32" ? "esbuild.exe" : "bin/esbuild";
  try {
    const main = fileURLToPath(resolve("esbuild"));
    return createRequire(main).resolve(`@esbuild/${platform}-${arch}/${subpath}`);
  } catch {
    return null;
  }
}

/** Messages the bootstrap sends through the CDP binding. */
export type TargetMessage =
  | { kind: "iopub"; msg_type: string; content: CdpParams; metadata: CdpParams; buffers: string[]; barrier: number }
  | { kind: "input_request"; prompt: string; password: boolean; barrier: number };

/** The parsed value, or undefined for text that isn't JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function isTargetMessage(value: unknown): value is TargetMessage {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return (kind === "iopub" || kind === "input_request") &&
    typeof (value as { barrier?: unknown }).barrier === "number";
}

type PipeItem = { text: string } | { barrier: number; gated: boolean };

const MARKER_PREFIX = "\x1b[cdpk:";

function isPartialMarker(tail: string): boolean {
  if (tail.length >= MAX_MARKER_LEN) return false;
  return MARKER_PREFIX.startsWith(tail) || /^\x1b\[cdpk:\d*m?\]?$/.test(tail);
}

/**
 * Splits one output pipe into text and barrier markers, and releases them
 * in order. A gated marker (one that announces a binding message) pauses
 * the pipe until `gate(n)` resolves, i.e. until that message has been
 * delivered, so later output can't overtake it. A possible partial marker
 * at the end of a chunk is held back until the next chunk decides it.
 */
export class PipeDemux {
  #buffer = "";
  #items: PipeItem[] = [];
  #pumping = false;
  #closed = false;
  #reached = 0;
  #waiters: { n: number; resolve: () => void }[] = [];
  readonly onText: (text: string) => void;
  readonly gate: (n: number) => Promise<void>;

  constructor(onText: (text: string) => void, gate: (n: number) => Promise<void> = () => Promise.resolve()) {
    this.onText = onText;
    this.gate = gate;
  }

  push(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const m = MARKER_RE.exec(this.#buffer);
      if (!m) break;
      if (m.index > 0) this.#items.push({ text: this.#buffer.slice(0, m.index) });
      this.#items.push({ barrier: Number(m[1]), gated: m[2] === "m" });
      this.#buffer = this.#buffer.slice(m.index + m[0].length);
    }
    // Hold back a tail that could still grow into a marker, including one
    // cut inside the "\x1b[cdpk:" prefix itself.
    const esc = this.#buffer.lastIndexOf("\x1b");
    const tail = esc === -1 ? "" : this.#buffer.slice(esc);
    const holdFrom = esc !== -1 && isPartialMarker(tail) ? esc : this.#buffer.length;
    if (holdFrom > 0) {
      this.#items.push({ text: this.#buffer.slice(0, holdFrom) });
      this.#buffer = this.#buffer.slice(holdFrom);
    }
    void this.#pump();
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (let item = this.#items.shift(); item; item = this.#items.shift()) {
        if ("text" in item) {
          this.onText(item.text);
          continue;
        }
        this.#reach(item.barrier);
        if (item.gated && !this.#closed) await this.gate(item.barrier);
      }
    } finally {
      this.#pumping = false;
    }
  }

  #reach(n: number): void {
    this.#reached = Math.max(this.#reached, n);
    this.#waiters = this.#waiters.filter((w) => {
      if (w.n > this.#reached) return true;
      w.resolve();
      return false;
    });
  }

  waitFor(n: number): Promise<void> {
    if (n <= this.#reached) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push({ n, resolve }));
  }

  /** Release everything (the process died). */
  close(): void {
    this.#closed = true;
    if (this.#buffer) this.#items.push({ text: this.#buffer });
    this.#buffer = "";
    this.#items.push({ barrier: Number.MAX_SAFE_INTEGER, gated: false });
    void this.#pump();
  }
}

/**
 * Removes the runtime's own stderr lines (see INSPECTOR_CHATTER) and passes
 * everything else on. A chatter line can arrive split across chunks, so a
 * trailing partial line that could still turn out to be one is held back
 * until its newline arrives; any other partial line passes straight through.
 */
export class StderrFilter {
  readonly #starts: readonly string[];
  readonly #emit: (text: string) => void;
  #held = "";
  #atLineStart = true;

  constructor(runtime: CdpRuntime, emit: (text: string) => void) {
    this.#starts = runtime === "deno" ? DENO_CHATTER : INSPECTOR_CHATTER;
    this.#emit = emit;
  }

  push(chunk: string): void {
    let text = this.#held + chunk;
    this.#held = "";
    let out = "";
    if (!this.#atLineStart) {
      // The rest of a line that already went out unfiltered.
      const nl = text.indexOf("\n");
      if (nl === -1) {
        this.#emit(text);
        return;
      }
      out = text.slice(0, nl + 1);
      text = text.slice(nl + 1);
    }
    const lines = text.split("\n");
    const last = lines.pop()!;
    for (const line of lines) if (!this.#isChatter(line, false)) out += line + "\n";
    if (last && this.#isChatter(last, true)) this.#held = last;
    else out += last;
    this.#atLineStart = last === "" || this.#held !== "";
    if (out) this.#emit(out);
  }

  /** Releases a held partial line (the process died). */
  flush(): void {
    if (this.#held) this.#emit(this.#held);
    this.#held = "";
    this.#atLineStart = true;
  }

  /** Whether `line` is chatter or, when `partial`, could still become chatter. */
  #isChatter(line: string, partial: boolean): boolean {
    let plain = line.replace(ANSI_SGR, "");
    if (partial) plain = plain.replace(PARTIAL_SGR, "");
    // Any other escape may be a PipeDemux marker, which must never be dropped or held.
    if (plain.includes("\x1b")) return false;
    return this.#starts.some((start) => plain.startsWith(start) || (partial && start.startsWith(plain)));
  }
}

/** Promises keyed by barrier number, resolvable before or after first use. */
export class Gates {
  #map = new Map<number, { promise: Promise<void>; resolve: () => void }>();
  #entry(n: number) {
    let entry = this.#map.get(n);
    if (!entry) {
      let resolve = () => {};
      const promise = new Promise<void>((r) => (resolve = r));
      entry = { promise, resolve };
      this.#map.set(n, entry);
    }
    return entry;
  }
  wait(n: number): Promise<void> {
    return this.#entry(n).promise;
  }
  open(n: number): void {
    this.#entry(n).resolve();
  }
  openAll(): void {
    for (const entry of this.#map.values()) entry.resolve();
    this.#map.clear();
  }
}

export interface TargetEvents {
  stream(name: "stdout" | "stderr", text: string): void;
  message(msg: TargetMessage): void;
  /** `note` says why, when the target was stopped on purpose. */
  exit(code: number | null, note?: string): void;
}

export class Interrupted extends Error {
  override name = "Interrupted";
}

export class Target implements KernelTarget {
  readonly runtime: CdpRuntime;
  readonly transform = transformCell;
  #child: ChildProcessWithoutNullStreams;
  #shell: CdpSession;
  #control: CdpSession;
  #stdout: PipeDemux;
  #stderr: PipeDemux;
  #gates: Gates;
  #contextId: number;
  #messages: Promise<void> = Promise.resolve();
  #interrupted = false;
  #paused = false;
  readonly #baselineGlobals = new Set<string>();
  readonly versions: { runtime: string; engine: string };

  private constructor(
    runtime: CdpRuntime,
    child: ChildProcessWithoutNullStreams,
    shell: CdpSession,
    control: CdpSession,
    stdout: PipeDemux,
    stderr: PipeDemux,
    gates: Gates,
    contextId: number,
    versions: { runtime: string; engine: string },
  ) {
    this.runtime = runtime;
    this.#child = child;
    this.#shell = shell;
    this.#control = control;
    this.#stdout = stdout;
    this.#stderr = stderr;
    this.#gates = gates;
    this.#contextId = contextId;
    this.versions = versions;
  }

  static async launch(
    runtime: CdpRuntime,
    events: TargetEvents,
    options: {
      cwd?: string;
      executable?: string;
      denoCompat?: boolean;
      denoConfig?: string;
      startTimeoutMs?: number;
    } = {},
  ): Promise<Target> {
    const runtimeUrl = new URL("../runtime/", import.meta.url).href;
    // A Deno target ignores the project's import map for imports made from
    // under node_modules, so an npm install's runtime files are copied out.
    const copy = runtime === "deno" && isInsideNodeModules(runtimeUrl);
    const bootstrap = join(await runtimeDir(runtimeUrl, undefined, undefined, { copy }), "bootstrap.mjs");
    const { cmd, args } = launchCommand(runtime, bootstrap, {
      executable: options.executable,
      denoConfig: options.denoConfig,
    });
    const env: Record<string, string | undefined> = { ...process.env, FORCE_COLOR: "1" };
    if (options.denoCompat) env.CDPK_DENO_COMPAT = "1";
    if (runtime === "deno" && options.denoConfig !== undefined) env.CDPK_DENO_PROJECT = "1";
    const esbuild = runtime === "node" ? esbuildBinary() : null;
    if (esbuild !== null) env.CDPK_ESBUILD_BINARY = esbuild;
    delete env.NO_COLOR;
    const child = spawn(cmd, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], env });
    killOnExit(child);
    // A start that fails or stalls must not leave the runtime running: its
    // pipes and inspector sockets would keep this process alive (#52).
    const sessions: CdpSession[] = [];
    const timeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${cmd} did not start within ${timeoutMs / 1000}s`)), timeoutMs);
    });
    try {
      return await Promise.race([Target.#start(runtime, events, cmd, child, sessions), stalled]);
    } catch (error) {
      for (const session of sessions) session.close();
      child.kill();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  static async #start(
    runtime: CdpRuntime,
    events: TargetEvents,
    cmd: string,
    child: ChildProcessWithoutNullStreams,
    sessions: CdpSession[],
  ): Promise<Target> {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const gates = new Gates();
    const stdout = new PipeDemux((text) => events.stream("stdout", text), (n) => gates.wait(n));
    const stderr = new PipeDemux((text) => events.stream("stderr", text), (n) => gates.wait(n));
    const filter = new StderrFilter(runtime, (text) => stderr.push(text));
    const pushStderr = (chunk: string) => filter.push(chunk);
    // Until the inspector URL appears, stderr carries the runtime's banner.
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let banner = "";
      const onData = (chunk: string) => {
        banner += chunk;
        const m = /ws:\/\/\S+/.exec(banner);
        if (!m) return;
        child.stderr.off("data", onData);
        pushStderr(banner.slice(m.index + m[0].length).replace(/^.*\n?/, ""));
        child.stderr.on("data", pushStderr);
        resolve(m[0]);
      };
      child.stderr.on("data", onData);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`${cmd} exited (${code}) before its inspector came up:\n${banner}`)));
    });
    child.stdout.on("data", (c: string) => stdout.push(c));
    child.once("exit", (code) => {
      gates.openAll();
      filter.flush();
      stdout.close();
      stderr.close();
      events.exit(code);
    });

    const shell = await CdpSession.connect(wsUrl);
    sessions.push(shell);
    const control = await CdpSession.connect(wsUrl);
    sessions.push(control);

    const contextReady = new Promise<number>((resolve) => {
      shell.on("Runtime.executionContextCreated", (params) => {
        const context = params.context as { id: number; auxData?: { isDefault?: boolean } };
        if (context.auxData?.isDefault !== false) resolve(context.id);
      });
    });
    await shell.send("Runtime.enable");
    await shell.send("Runtime.addBinding", { name: BINDING });
    const contextId = await contextReady;

    const target = new Target(runtime, child, shell, control, stdout, stderr, gates, contextId, { runtime: "", engine: "" });
    shell.on("Runtime.bindingCalled", (params) => {
      if (params.name !== BINDING || typeof params.payload !== "string") return;
      // __cdpk_send is an ordinary global, so a cell can call it with
      // anything; that mustn't take the host down (#122).
      const msg = parseJson(params.payload);
      if (isTargetMessage(msg)) target.#deliver(msg, events);
    });

    // Wait for the bootstrap's top-level await to finish installing the
    // shim. There is no cap here: launch's start timeout bounds the wait and
    // kills the child, so a slow bootstrap never yields a target without
    // the shim (#134).
    for (;;) {
      const probe = await target.#evaluateSync(`typeof globalThis.${SHIM}?.tick === "function"`);
      if (probe.result.value === true) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const versions = await target.#evaluateSync(
      `JSON.stringify(typeof Deno !== "undefined" ? { runtime: Deno.version.deno, engine: "V8 " + Deno.version.v8 } : { runtime: process.versions.node, engine: "V8 " + process.versions.v8 })`,
    );
    Object.assign(target.versions, JSON.parse(String(versions.result.value)));
    // The runtime's own enumerable globals, before any cell: the debugger's
    // variable views show only what cells added (#18).
    const globals = asEvaluateResult(
      await shell.send("Runtime.evaluate", { expression: "Object.keys(globalThis)", contextId, returnByValue: true }),
    );
    const names = globals.result.value;
    if (Array.isArray(names)) for (const name of names) target.#baselineGlobals.add(String(name));
    shell.on("Debugger.paused", () => (target.#paused = true));
    shell.on("Debugger.resumed", () => (target.#paused = false));
    return target;
  }

  /** The Debugger domain on this target's session, for src/debugger.ts. */
  get debug(): DebugChannel {
    return {
      send: (method, params = {}) => this.#shell.send(method, params),
      on: (method, listener) => this.#shell.on(method, listener),
      contextId: this.#contextId,
      baselineGlobals: this.#baselineGlobals,
    };
  }

  // Binding messages wait until both pipes have caught up to their marker,
  // and are delivered strictly in order.
  #deliver(msg: TargetMessage, events: TargetEvents): void {
    this.#messages = this.#messages.then(async () => {
      await Promise.all([this.#stdout.waitFor(msg.barrier), this.#stderr.waitFor(msg.barrier)]);
      events.message(msg);
      this.#gates.open(msg.barrier);
    });
  }

  /** Resolves once all output and messages sent so far have been delivered. */
  async flush(): Promise<void> {
    const n = await this.#evaluateSync(`${SHIM}.barrier()`);
    const barrier = Number(n.result.value);
    await Promise.all([this.#stdout.waitFor(barrier), this.#stderr.waitFor(barrier)]);
    await this.#messages;
  }

  /**
   * For expressions that return a value without awaiting. With replMode or
   * awaitPromise, the inspector holds the result promise only weakly until
   * its then-callback runs, even when the expression returns a plain value:
   * a GC in that window fails the call with "Promise was collected" (#50).
   * A plain evaluate returns the value directly.
   */
  #evaluateSync(expression: string): Promise<EvaluateResult> {
    return this.#shell
      .send("Runtime.evaluate", { expression, contextId: this.#contextId, returnByValue: true })
      .then(asEvaluateResult);
  }

  #evaluateRaw(expression: string, session = this.#shell): Promise<EvaluateResult> {
    return session
      .send("Runtime.evaluate", { expression, contextId: this.#contextId, replMode: true, awaitPromise: true })
      .then(asEvaluateResult);
  }

  /** Runs transformed cell code. Rejects with Interrupted after interrupt(). */
  async evaluate(script: string): Promise<EvaluateResult> {
    this.#interrupted = false;
    try {
      return await this.#evaluateRaw(script);
    } catch (err) {
      if (err instanceof CdpAbandoned || this.#interrupted) throw new Interrupted("Execution interrupted");
      throw err;
    }
  }

  /**
   * Deno calls IsolateHandle::terminate_execution from another thread. The
   * CDP equivalent is Runtime.terminateExecution, sent on a second session
   * because the shell session is the one blocked on the running evaluate.
   * Terminated code never settles the awaited promise, so the pending
   * evaluate is abandoned here and the session stays usable.
   */
  async interrupt(): Promise<void> {
    this.#interrupted = true;
    // A paused isolate runs nothing to terminate: let it go first (#18).
    if (this.#paused) await this.#shell.send("Debugger.resume").catch(() => {});
    await this.#control.send("Runtime.terminateExecution");
    this.#shell.abandonPending();
  }

  /**
   * For synchronous functions. With awaitPromise the inspector would wrap
   * even a plain return value in a promise it holds only weakly (#55).
   */
  callFunctionOn(functionDeclaration: string, args: CdpParams[]): Promise<CdpParams> {
    return this.#shell.send("Runtime.callFunctionOn", {
      functionDeclaration,
      arguments: args,
      executionContextId: this.#contextId,
      returnByValue: true,
    });
  }

  /**
   * For functions that return a promise. The target holds it until after
   * the inspector's then-callback has run, so a GC can't collect it first.
   */
  #callAsyncFunctionOn(functionDeclaration: string, args: CdpParams[]): Promise<CdpParams> {
    return this.#shell.send("Runtime.callFunctionOn", {
      functionDeclaration: `function (...args) { return globalThis.${SHIM}.hold((${functionDeclaration}).apply(this, args)); }`,
      arguments: args,
      executionContextId: this.#contextId,
      awaitPromise: true,
      returnByValue: true,
    });
  }

  /** The broadcastResult step of Deno's execute flow (jupyter/mod.rs). */
  async broadcastResult(executionCount: number, result: RemoteObject): Promise<void> {
    const arg = result.objectId
      ? { objectId: result.objectId }
      : result.unserializableValue !== undefined
      ? { unserializableValue: result.unserializableValue }
      : { value: result.value };
    await this.#callAsyncFunctionOn(`function (n, r) { return globalThis.${SHIM}.broadcastResult(n, r); }`, [
      { value: executionCount },
      arg,
    ]);
  }

  /**
   * Hands a frontend comm message to the target's comms. Resolves to
   * whether a comm or registered target took it, or to the error a handler
   * threw. Rejects with Interrupted after interrupt().
   */
  async dispatchComm(
    msgType: string,
    content: CdpParams,
    metadata: CdpParams,
    buffers: Uint8Array[],
  ): Promise<{ handled: boolean } | { error: { name: string; message: string; stack: string } }> {
    this.#interrupted = false;
    let res: CdpParams;
    try {
      res = await this.#callAsyncFunctionOn(
        `function (t, c, m, b) { return globalThis.${SHIM}.commDispatch(t, c, m, b); }`,
        [
          { value: msgType },
          { value: content },
          { value: metadata },
          { value: buffers.map((b) => Buffer.from(b).toString("base64")) },
        ],
      );
    } catch (err) {
      if (err instanceof CdpAbandoned || this.#interrupted) throw new Interrupted("Comm handler interrupted");
      throw err;
    }
    const details = res.exceptionDetails as EvaluateResult["exceptionDetails"];
    if (details) {
      const error = details.exception
        ? await this.describeError(details.exception)
        : { name: "Error", message: details.text, stack: "" };
      return { error };
    }
    return { handled: (res.result as RemoteObject | undefined)?.value === true };
  }

  async describeError(exception: RemoteObject): Promise<{ name: string; message: string; stack: string }> {
    const arg = exception.objectId ? { objectId: exception.objectId } : { value: exception.value };
    const res = await this.callFunctionOn(`function (e) { return globalThis.${SHIM}.describeError(e); }`, [arg]);
    const value = (res.result as RemoteObject | undefined)?.value;
    return JSON.parse(typeof value === "string" ? value : '{"name":"Error","message":"","stack":""}');
  }

  /**
   * Evaluates without side effects: V8 throws instead of running anything
   * that would change state (a call, a getter that writes), so completing
   * or inspecting `obj.` never runs user code (#10). Not replMode, which
   * returns a promise the inspector holds only weakly (#55); a plain
   * evaluate sees the cells' let and const too.
   */
  #evaluatePure(expression: string): Promise<EvaluateResult | null> {
    return this.#shell
      .send("Runtime.evaluate", { expression, contextId: this.#contextId, throwOnSideEffect: true })
      .then(asEvaluateResult)
      .catch(() => null);
  }

  async propertyNames(expression: string): Promise<string[]> {
    const evaluated = await this.#evaluatePure(`(${expression})`);
    const objectId = evaluated?.result.objectId;
    if (!objectId || evaluated?.exceptionDetails) return [];
    const props = await this.#shell.send("Runtime.getProperties", { objectId, nonIndexedPropertiesOnly: true });
    const list = props.result as { name: string }[] | undefined;
    return (list ?? []).map((p) => p.name);
  }

  async inspect(path: string, detail: number): Promise<string | null> {
    const found = await this.#evaluatePure(path);
    if (!found || found.exceptionDetails) return null;
    const value = found.result;
    const arg = value.objectId
      ? { objectId: value.objectId }
      : value.unserializableValue !== undefined
      ? { unserializableValue: value.unserializableValue }
      : { value: value.value };
    const res = await this.callFunctionOn(`function (v, d) { return globalThis.${SHIM}.describeForInspect(v, d); }`, [
      arg,
      { value: detail },
    ]);
    const text = (res.result as RemoteObject | undefined)?.value;
    return typeof text === "string" ? text : null;
  }

  async lexicalNames(): Promise<string[]> {
    const res = await this.#shell.send("Runtime.globalLexicalScopeNames", { executionContextId: this.#contextId });
    return (res.names as string[] | undefined) ?? [];
  }

  replyInput(value: string | null): void {
    this.#child.stdin.write(JSON.stringify({ value }) + "\n");
  }

  kill(): void {
    this.#shell.close();
    this.#control.close();
    this.#child.kill();
  }
}
