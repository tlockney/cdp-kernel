// A target runtime driven over CDP: the stand-in for Deno's REPL isolate and
// the ops in cli/ops/jupyter.rs. Any runtime whose --inspect speaks CDP and
// can load runtime/bootstrap.mjs works; Node and Deno are wired up here.

import { Buffer } from "node:buffer";
import process from "node:process";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { asEvaluateResult, CdpAbandoned, CdpError, CdpSession, type CdpParams, type EvaluateResult, type RemoteObject } from "./cdp.ts";
import { type CellTransformOptions, SHIM, transformCell } from "./transform.ts";
import type { DebugChannel } from "./debugger.ts";
import { hostRuntime, isInsideNodeModules, runtimeDir } from "./package.ts";
import { killOnExit } from "./children.ts";
import {
  type CdpRuntime,
  Interrupted,
  isTargetMessage,
  type KernelTarget,
  parseBundle,
  parseJson,
  type RuntimeName,
  type TargetEvents,
  type TargetMessage,
  withStartTimeout,
} from "./target-api.ts";

export { Interrupted, isTargetMessage, parseBundle, parseJson };
export type { CdpRuntime, KernelTarget, RuntimeName, TargetEvents, TargetMessage } from "./target-api.ts";

/**
 * The inspector keeps every object it returns a remote reference to alive
 * until it is released, so a cell's result would never be collected (#286).
 * Cells and lookups put theirs in these groups, which are released once the
 * kernel is done with them.
 */
const CELL_GROUP = "cdpk-cell";
const LOOKUP_GROUP = "cdpk-lookup";

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
// Deno prints "Debugger session started." for each session the host opens
// (#281).
const DENO_CHATTER = [...INSPECTOR_CHATTER, "Debugger session started.", "Download http://", "Download https://"];
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

type PipeItem = { text: string } | { barrier: number; gated: boolean } | { message: TargetMessage };

const MARKER_PREFIX = "\x1b[cdpk:";
// A message record: the message's JSON, which never holds a raw ESC, between
// "\x1b[cdpk:<" and "\x1b]" (#271).
const RECORD_PREFIX = "\x1b[cdpk:<";
const RECORD_RE = /\x1b\[cdpk:<([^\x1b]*)\x1b\]/;

function isPartialMarker(tail: string): boolean {
  if (tail.length >= MAX_MARKER_LEN) return false;
  return MARKER_PREFIX.startsWith(tail) || /^\x1b\[cdpk:\d*m?\]?$/.test(tail);
}

/**
 * Splits one output pipe into text and barrier markers, and releases them
 * in order. A gated marker (one that announces a message) pauses
 * the pipe until `gate(n)` resolves, i.e. until that message has been
 * delivered, so later output can't overtake it. A possible partial marker
 * at the end of a chunk is held back until the next chunk decides it.
 *
 * With `onMessage`, the pipe also carries message records. A record stands
 * where its gated marker would, and pauses the pipe the same way.
 */
export class PipeDemux {
  #buffer = "";
  #items: PipeItem[] = [];
  #pumping = false;
  #closed = false;
  #reached = 0;
  #waiters: { n: number; resolve: () => void }[] = [];
  /** The gated marker the pipe is paused on, if any. */
  #gatedOn: number | null = null;
  readonly onText: (text: string) => void;
  readonly gate: (n: number) => Promise<void>;
  readonly onMessage: ((msg: TargetMessage) => void) | null;

  constructor(
    onText: (text: string) => void,
    gate: (n: number) => Promise<void> = () => Promise.resolve(),
    onMessage: ((msg: TargetMessage) => void) | null = null,
  ) {
    this.onText = onText;
    this.gate = gate;
    this.onMessage = onMessage;
  }

  push(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const m = MARKER_RE.exec(this.#buffer);
      const r = this.onMessage ? RECORD_RE.exec(this.#buffer) : null;
      const first = m && r ? (m.index < r.index ? m : r) : m ?? r;
      if (!first) break;
      if (first.index > 0) this.#items.push({ text: this.#buffer.slice(0, first.index) });
      if (first === m) {
        this.#items.push({ barrier: Number(m[1]), gated: m[2] === "m" });
      } else {
        // Anything else a cell prints in this shape is dropped (#122).
        const msg = parseJson(first[1]);
        if (isTargetMessage(msg)) this.#items.push({ message: msg });
      }
      this.#buffer = this.#buffer.slice(first.index + first[0].length);
    }
    // Hold back a tail that could still grow into a marker, including one
    // cut inside the "\x1b[cdpk:" prefix itself, or into a record: one
    // whose only ESC after its prefix is a final one.
    const esc = this.#buffer.lastIndexOf("\x1b");
    const tail = esc === -1 ? "" : this.#buffer.slice(esc);
    let holdFrom = esc !== -1 && isPartialMarker(tail) ? esc : this.#buffer.length;
    const record = this.onMessage ? this.#buffer.lastIndexOf(RECORD_PREFIX) : -1;
    if (record !== -1) {
      const next = this.#buffer.indexOf("\x1b", record + RECORD_PREFIX.length);
      if (next === -1 || next === this.#buffer.length - 1) holdFrom = Math.min(holdFrom, record);
    }
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
        if ("message" in item) {
          this.#reach(item.message.barrier);
          this.onMessage?.(item.message);
          if (!this.#closed) {
            this.#gatedOn = item.message.barrier;
            await this.gate(item.message.barrier);
            this.#gatedOn = null;
          }
          continue;
        }
        this.#reach(item.barrier);
        if (item.gated && !this.#closed) {
          this.#gatedOn = item.barrier;
          await this.gate(item.barrier);
          this.#gatedOn = null;
        }
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

  /** Where the pipe stands, for a state dump (#237). */
  state(): { reached: number; waitingFor: number[]; gatedOn: number | null; queued: number; held: number } {
    return {
      reached: this.#reached,
      waitingFor: this.#waiters.map((w) => w.n),
      gatedOn: this.#gatedOn,
      queued: this.#items.length,
      held: this.#buffer.length,
    };
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

/** A catch handler: a call interrupt() abandoned becomes Interrupted. */
function interrupted(what: string): (err: unknown) => never {
  return (err) => {
    throw err instanceof CdpAbandoned ? new Interrupted(`${what} interrupted`) : err;
  };
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
  /** Messages received but not yet delivered. */
  #undelivered = 0;
  #interrupted = false;
  #paused = false;
  /** What the debugger asked to pause on (#307), and how many kernel calls hold it off. */
  #pauseOnExceptions = "none";
  #unpausable = 0;
  /** Set once the main context is gone: the runtime is exiting (#130). */
  #exiting = false;
  readonly #exited: Promise<void>;
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
    this.#exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
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
    // Prompt replies and comm messages go to stdin; one written as the
    // runtime exits fails with EPIPE, and the exit is handled on its own.
    child.stdin.on("error", () => {});
    // A start that fails or stalls must not leave the runtime running: its
    // pipes and inspector sockets would keep this process alive (#52).
    const sessions: CdpSession[] = [];
    try {
      return await withStartTimeout(Target.#start(runtime, events, cmd, child, sessions), cmd, options.startTimeoutMs);
    } catch (error) {
      for (const session of sessions) session.close();
      child.kill();
      throw error;
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
    // Messages come only after attach(), so the target exists by then.
    let target: Target | undefined;
    const stdout = new PipeDemux(
      (text) => events.stream("stdout", text),
      (n) => gates.wait(n),
      (msg) => {
        if (target) target.#deliver(msg, events);
      },
    );
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
    const contextId = await contextReady;
    // The inspector socket leaves Nagle's algorithm on, so an event written
    // just before an evaluate's reply holds that reply until the event is
    // acknowledged, ~40 ms on Linux (#271). So the shell session, which runs
    // the cells, takes no Runtime events (console calls among them), and
    // messages come over stdout. The control session watches for exit.
    await shell.send("Runtime.disable");
    await control.send("Runtime.enable");

    target = new Target(runtime, child, shell, control, stdout, stderr, gates, contextId, { runtime: "", engine: "" });
    // process.exit() or Deno.exit() destroys the context, then the runtime
    // waits for its inspector clients to disconnect before it exits. Let go,
    // so it exits and the kernel starts a fresh one (#130).
    control.on("Runtime.executionContextDestroyed", (params) => {
      if (params.executionContextId === contextId && target) target.#onExit();
    });
    // A session that closes on its own (e.g. a frame that isn't JSON, #337)
    // leaves a target nothing can drive: stop it, so the next cell starts
    // a fresh one.
    for (const session of [shell, control]) {
      session.onClose(() => {
        if (target) target.#onExit();
      });
    }

    // Wait for the bootstrap's top-level await to finish installing the
    // shim. There is no cap here: launch's start timeout bounds the wait and
    // kills the child, so a slow bootstrap never yields a target without
    // the shim (#134).
    for (;;) {
      const probe = await target.#evaluateSync(`typeof globalThis.${SHIM}?.tick === "function"`);
      if (probe.result.value === true) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await target.#evaluateSync(`${SHIM}.attach()`);
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
      send: (method, params = {}) => {
        if (method === "Debugger.setPauseOnExceptions") {
          this.#pauseOnExceptions = String(params.state ?? "none");
          // Applied when the kernel's own call in flight finishes.
          if (this.#unpausable > 0) return Promise.resolve({});
        }
        if (method === "Debugger.disable") this.#pauseOnExceptions = "none";
        return this.#shell.send(method, params);
      },
      on: (method, listener) => this.#shell.on(method, listener),
      contextId: this.#contextId,
      baselineGlobals: this.#baselineGlobals,
      withoutPausing: (call) => this.#withoutPausing(call),
    };
  }

  /**
   * Runs the kernel's own inspector call with pausing on exceptions off. A
   * pause inside a call the inspector dispatches holds that call (Node), or
   * resumes by itself and leaves Deno's event loop stopped for good, so no
   * later cell runs (#307). A cell that throws meanwhile doesn't pause.
   */
  async #withoutPausing<T>(call: () => Promise<T>): Promise<T> {
    if (this.#pauseOnExceptions === "none" || this.#paused) return call();
    if (this.#unpausable++ === 0) await this.#shell.send("Debugger.setPauseOnExceptions", { state: "none" });
    try {
      return await call();
    } finally {
      if (--this.#unpausable === 0 && !this.#exiting) {
        await this.#shell.send("Debugger.setPauseOnExceptions", { state: this.#pauseOnExceptions }).catch(() => {});
      }
    }
  }

  // Messages wait until both pipes have caught up to their marker,
  // and are delivered strictly in order.
  #deliver(msg: TargetMessage, events: TargetEvents): void {
    this.#undelivered++;
    this.#messages = this.#messages.then(async () => {
      await Promise.all([this.#stdout.waitFor(msg.barrier), this.#stderr.waitFor(msg.barrier)]);
      this.#undelivered--;
      events.message(msg);
      this.#gates.open(msg.barrier);
    });
  }

  /**
   * What the host is waiting on, whether the runtime still evaluates, runs
   * immediates and runs timers, and where its JavaScript is if it is
   * running any, for a kernel that has stopped answering (#237). The probes
   * go over the control session, which no cell holds.
   */
  async diagnose(): Promise<CdpParams> {
    const within = <T>(promise: Promise<T>, fallback: T) =>
      Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), 2000).unref())]);
    const probe = (expression: string, awaitPromise: boolean) =>
      within(
        this.#control.send("Runtime.evaluate", { expression, contextId: this.#contextId, awaitPromise, returnByValue: true })
          .then((res) => res.exceptionDetails ? `threw: ${JSON.stringify(res.exceptionDetails)}` : String((res.result as RemoteObject | undefined)?.value), (err) => `failed: ${err}`),
        "no answer in 2 s",
      );
    const [evaluates, immediates, timers] = await Promise.all([
      probe("'yes'", false),
      probe("new Promise((resolve) => setImmediate(() => resolve('yes')))", true),
      probe("new Promise((resolve) => setTimeout(() => resolve('yes'), 0))", true),
    ]);
    // A runtime whose event loop is stuck may be stuck in JavaScript: say
    // where. (An idle one would take the pause in whatever runs next.)
    let running: unknown = "event loop runs";
    if (immediates !== "yes") {
      try {
        const paused = new Promise<CdpParams>((resolve) => this.#control.on("Debugger.paused", resolve));
        await this.#control.send("Debugger.enable");
        await this.#control.send("Debugger.pause");
        const event = await within(paused, null);
        running = event === null ? "no" : (event.callFrames as { functionName: string; url: string; location: { lineNumber: number } }[])
          .slice(0, 10)
          .map((f) => `${f.functionName || "(anonymous)"} ${f.url || "(no url)"}:${f.location.lineNumber + 1}`);
        await this.#control.send("Debugger.resume").catch(() => {});
        await this.#control.send("Debugger.disable");
      } catch (err) {
        running = `failed: ${err}`;
      }
    }
    return {
      pid: this.#child.pid ?? null,
      calls: { shell: this.#shell.pendingCalls(), control: this.#control.pendingCalls() },
      stdout: this.#stdout.state(),
      stderr: this.#stderr.state(),
      undelivered: this.#undelivered,
      paused: this.#paused,
      exiting: this.#exiting,
      evaluates,
      immediates,
      timers,
      running,
    };
  }

  /** Resolves once all output and messages sent so far have been delivered. */
  async flush(): Promise<void> {
    const n = await this.#evaluateSync(`${SHIM}.barrier()`).catch(interrupted("Execution"));
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
      .send("Runtime.evaluate", {
        expression,
        contextId: this.#contextId,
        replMode: true,
        awaitPromise: true,
        objectGroup: CELL_GROUP,
      })
      .then(asEvaluateResult);
  }

  /** Runs transformed cell code. Rejects with Interrupted after interrupt(). */
  async evaluate(script: string): Promise<EvaluateResult> {
    this.#interrupted = false;
    try {
      return await this.#evaluateRaw(script);
    } catch (err) {
      if (err instanceof CdpAbandoned || this.#interrupted) throw new Interrupted("Execution interrupted");
      // The control session's executionContextDestroyed event can arrive
      // after the shell session's error reply (#271 moved it there).
      if (err instanceof CdpError && err.message.includes("Execution context was destroyed")) this.#onExit();
      if (this.#exiting) {
        // The child's exit, which drops this target in the kernel, comes
        // first, so the next cell starts a fresh one.
        await this.#exited;
        throw new Error(`${this.runtime} exited`);
      }
      throw err;
    }
  }

  async releaseResults(): Promise<void> {
    if (this.#exiting) return;
    await this.#shell.send("Runtime.releaseObjectGroup", { objectGroup: CELL_GROUP }).catch(() => {});
  }

  #onExit(): void {
    if (this.#exiting) return;
    this.#exiting = true;
    this.#shell.close();
    this.#control.close();
    // In case it still doesn't exit once both sessions are gone.
    setTimeout(() => {
      if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill("SIGKILL");
    }, 2000).unref();
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
    return this.#withoutPausing(() =>
      this.#shell.send("Runtime.callFunctionOn", {
        functionDeclaration,
        arguments: args,
        executionContextId: this.#contextId,
        returnByValue: true,
      })
    );
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
    // An async $display method can still be running when interrupt()
    // abandons the call (#135).
    await this.#callAsyncFunctionOn(`function (n, r) { return globalThis.${SHIM}.broadcastResult(n, r); }`, [
      { value: executionCount },
      arg,
    ]).catch(interrupted("Execution"));
  }

  async format(value: RemoteObject): Promise<CdpParams> {
    const arg = value.objectId
      ? { objectId: value.objectId }
      : value.unserializableValue !== undefined
      ? { unserializableValue: value.unserializableValue }
      : { value: value.value };
    const res = await this.#callAsyncFunctionOn(`function (v) { return globalThis.${SHIM}.formatJson(v); }`, [arg])
      .catch(interrupted("Execution"));
    const thrown = res.exceptionDetails as { exception?: RemoteObject; text?: string } | undefined;
    if (thrown) throw new Error(thrown.exception?.description ?? thrown.text ?? "the value could not be formatted");
    return parseBundle((res.result as RemoteObject | undefined)?.value);
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
    // Over stdin, not as call arguments: V8 caches an argument's source,
    // so the data would stay in the target's memory (#287).
    const record = Buffer.from(JSON.stringify({
      msgType,
      content,
      metadata,
      buffers: buffers.map((b) => Buffer.from(b).toString("base64")),
    }));
    this.#child.stdin.write(`comm ${record.length}\n`);
    this.#child.stdin.write(record);
    let res: CdpParams;
    try {
      res = await this.#callAsyncFunctionOn(`function () { return globalThis.${SHIM}.commDispatchFromStdin(); }`, []);
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
      .send("Runtime.evaluate", { expression, contextId: this.#contextId, throwOnSideEffect: true, objectGroup: LOOKUP_GROUP })
      .then(asEvaluateResult)
      .catch(() => null);
  }

  #releaseLookup(): Promise<void> {
    return this.#shell.send("Runtime.releaseObjectGroup", { objectGroup: LOOKUP_GROUP }).then(() => {}, () => {});
  }

  async propertyNames(expression: string): Promise<string[]> {
    try {
      return await this.#propertyNames(expression);
    } finally {
      await this.#releaseLookup();
    }
  }

  async #propertyNames(expression: string): Promise<string[]> {
    const evaluated = await this.#evaluatePure(`(${expression})`);
    const objectId = evaluated?.result.objectId;
    if (!objectId || evaluated?.exceptionDetails) return [];
    const props = await this.#shell.send("Runtime.getProperties", { objectId, nonIndexedPropertiesOnly: true });
    const list = props.result as { name: string }[] | undefined;
    return (list ?? []).map((p) => p.name);
  }

  async inspect(path: string, detail: number): Promise<string | null> {
    try {
      return await this.#inspect(path, detail);
    } finally {
      await this.#releaseLookup();
    }
  }

  async #inspect(path: string, detail: number): Promise<string | null> {
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

  replyInput(value: string | null, interrupted = false): void {
    this.#child.stdin.write(JSON.stringify({ value, interrupted }) + "\n");
  }

  kill(): void {
    this.#shell.close();
    this.#control.close();
    this.#child.kill();
  }
}
