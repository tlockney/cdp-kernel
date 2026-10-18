// The Jupyter debugger protocol (#18): JupyterLab's visual debugger sends
// DAP requests as debug_request messages and listens for DAP events on
// debug_event. For CDP targets (Node, Deno) this translates them to V8's
// Debugger domain on the target's existing session.
//
// Cells are named as JupyterLab names them, tmpFilePrefix + murmur2(code,
// hashSeed) + tmpFileSuffix (src/murmur2.ts), and evaluated with that name
// as their //# sourceURL, so breakpoints bind and frames point at the cell.
// Lines go through the cell's source map (src/sourcemap.ts), since esbuild
// rewrites TypeScript.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { type CdpParams, isRecord, isRemoteObject, type RemoteObject } from "./cdp.ts";
import { murmur2 } from "./murmur2.ts";
import type { LineMap } from "./sourcemap.ts";
import { type CellTransformOptions, SETTLE, transformCellWithLines } from "./transform.ts";

/** What the debugger needs from a CDP target: its session, with the Debugger domain. */
export interface DebugChannel {
  send(method: string, params?: CdpParams): Promise<CdpParams>;
  on(method: string, listener: (params: CdpParams) => void): void;
  /** The execution context cells run in. */
  readonly contextId: number;
  /** Enumerable globals the runtime had before any cell ran. */
  readonly baselineGlobals: ReadonlySet<string>;
  /** Runs a call of the kernel's own with pausing on exceptions held off (#307). */
  withoutPausing?<T>(call: () => Promise<T>): Promise<T>;
}

export type DapMessage = { [key: string]: unknown };

/** ipykernel's seed, so a kernel switch doesn't move JupyterLab's breakpoints. */
export const HASH_SEED = 0xc70f6907;
export const THREAD_ID = 1;

const EXCEPTION_FILTERS = [
  { filter: "caught", label: "Caught Exceptions", default: false },
  { filter: "uncaught", label: "Uncaught Exceptions", default: false },
];

/** Bindings the kernel itself installs, hidden from the variable views. */
const KERNEL_GLOBALS = new Set(["__cdpk", "__cdpk_send", "jupyter", "prompt", "confirm"]);

const SCOPE_NAMES: { [type: string]: string } = {
  local: "Locals",
  block: "Block",
  closure: "Closure",
  catch: "Catch",
  with: "With",
  script: "Script",
  module: "Module",
  eval: "Eval",
  global: "Globals",
};

interface CallFrame {
  callFrameId: string;
  functionName: string;
  location: { scriptId: string; lineNumber: number; columnNumber?: number };
  scopeChain: { type: string; object: RemoteObject; name?: string }[];
}


/**
 * CDPK_DEBUG_TRACE=1 logs every debug request, reply and event to stderr
 * (the Jupyter server's log), for diagnosing a frontend.
 */
function trace(kind: string, ...parts: unknown[]): void {
  if (process.env.CDPK_DEBUG_TRACE !== "1") return;
  const text = parts.map((p) => JSON.stringify(p)).join(" -> ");
  process.stderr.write(`[cdp-kernel debugger] ${kind} ${text.length > 600 ? `${text.slice(0, 600)}…` : text}\n`);
}

function isCallFrame(value: unknown): value is CallFrame {
  return isRecord(value) && typeof value.callFrameId === "string" && typeof value.functionName === "string" &&
    isRecord(value.location) && typeof value.location.scriptId === "string" &&
    typeof value.location.lineNumber === "number" && Array.isArray(value.scopeChain) &&
    value.scopeChain.every((scope) => isRecord(scope) && typeof scope.type === "string" && isRemoteObject(scope.object));
}

/** A DAP value string for a CDP RemoteObject. */
export function describeRemote(object: RemoteObject): string {
  if (object.type === "string") return JSON.stringify(object.value);
  if (object.unserializableValue !== undefined) return object.unserializableValue;
  if (object.description !== undefined) return object.description;
  if (object.type === "undefined") return "undefined";
  return JSON.stringify(object.value) ?? String(object.value);
}

function typeOf(object: RemoteObject): string {
  return object.className ?? object.subtype ?? object.type;
}

export class Debugger {
  readonly prefix: string;
  readonly suffix = ".ts";
  #channel: DebugChannel | null = null;
  #started = false;
  #seq = 0;
  /** Breakpoint lines (1-based, as the frontend set them) by cell path. */
  readonly #breakpoints = new Map<string, number[]>();
  /** The CDP breakpoint ids set for a path, to replace them. */
  readonly #cdpBreakpoints = new Map<string, string[]>();
  /** Each cell's code and line map, by path. */
  readonly #cells = new Map<string, { code: string; lines: LineMap | null }>();
  readonly #scripts = new Map<string, string>(); // scriptId -> url
  #frames: CallFrame[] = [];
  #stopped = false;
  #refs = new Map<number, { objectId: string; globals?: boolean }>();
  #nextRef = 1;
  #pauseOnExceptions: "none" | "uncaught" | "all" = "none";
  /** Called at the next pause; see #unlessPaused. */
  readonly #pauseWaiters: (() => void)[] = [];
  readonly #emit: (event: DapMessage) => void;
  readonly #transformOptions: () => CellTransformOptions;
  #cleanupRegistered = false;

  constructor(emit: (event: DapMessage) => void, transformOptions: () => CellTransformOptions = () => ({})) {
    this.#emit = emit;
    this.#transformOptions = transformOptions;
    this.prefix = join(tmpdir(), `cdp-kernel_${process.pid}`) + sep;
  }

  get started(): boolean {
    return this.#started && this.#channel !== null;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  /** A cell's path, as JupyterLab computes it for the same code. */
  pathFor(code: string): string {
    return `${this.prefix}${murmur2(code, HASH_SEED)}${this.suffix}`;
  }

  /**
   * The target to debug: called with each target the kernel launches. A
   * restarted target gets the session's breakpoints again.
   */
  async attachTarget(channel: DebugChannel | null): Promise<void> {
    this.#channel = channel;
    this.#scripts.clear();
    this.#resetStop();
    if (!channel) return;
    channel.on("Debugger.scriptParsed", (p) => {
      if (typeof p.scriptId === "string" && typeof p.url === "string") this.#scripts.set(p.scriptId, p.url);
    });
    channel.on("Debugger.paused", (p) => this.#onPaused(p));
    channel.on("Debugger.resumed", () => {
      if (!this.#stopped) return;
      this.#resetStop();
      this.#event("continued", { threadId: THREAD_ID, allThreadsContinued: true });
    });
    if (this.#started) await this.#enable();
  }

  /**
   * The script for a cell while debugging: transformed with its line map
   * kept, and named for its path. `source` is what actually runs (the cell,
   * or the cell wrapped as an object literal); the path comes from `code`,
   * the cell as the frontend sent it.
   */
  cellScript(code: string, source: string): string {
    const path = this.pathFor(code);
    const { script, lines } = transformCellWithLines(source, this.#transformOptions());
    this.#cells.set(path, { code, lines });
    this.#writeCell(path, code);
    return `${script}\n//# sourceURL=${path}`;
  }

  async handle(request: DapMessage): Promise<DapMessage> {
    const command = String(request.command ?? "");
    const args = isRecord(request.arguments) ? request.arguments : {};
    let response: DapMessage;
    try {
      const body = await this.#dispatch(command, args);
      response = { type: "response", seq: ++this.#seq, request_seq: request.seq, command, success: true, body };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      response = { type: "response", seq: ++this.#seq, request_seq: request.seq, command, success: false, message, body: {} };
    }
    trace("request", { command, arguments: args }, response);
    return response;
  }

  // --- requests -------------------------------------------------------------

  async #dispatch(command: string, args: CdpParams): Promise<CdpParams> {
    switch (command) {
      case "debugInfo":
        return this.#debugInfo();
      case "initialize":
        return {
          supportsConfigurationDoneRequest: true,
          supportsEvaluateForHovers: true,
          supportsSetVariable: false,
          supportsModulesRequest: false,
          exceptionBreakpointFilters: EXCEPTION_FILTERS,
        };
      case "attach":
        this.#started = true;
        if (this.#channel) await this.#enable();
        this.#event("initialized", {});
        return {};
      case "configurationDone":
        return {};
      case "disconnect":
        await this.#disable();
        return {};
      case "dumpCell": {
        const code = String(args.code ?? "");
        const path = this.pathFor(code);
        if (!this.#cells.has(path)) this.#cells.set(path, { code, lines: null });
        this.#writeCell(path, code);
        return { sourcePath: path };
      }
      case "setBreakpoints":
        return await this.#setBreakpoints(args);
      case "setExceptionBreakpoints": {
        const filters = Array.isArray(args.filters) ? args.filters.map(String) : [];
        this.#pauseOnExceptions = filters.includes("caught") ? "all" : filters.includes("uncaught") ? "uncaught" : "none";
        if (this.started) await this.#channel?.send("Debugger.setPauseOnExceptions", { state: this.#pauseOnExceptions });
        return {};
      }
      case "threads":
        return { threads: [{ id: THREAD_ID, name: "Main Thread" }] };
      // JupyterLab asks while restoring state, whatever the capability says,
      // and treats a failure as fatal: its debugger button stays disabled.
      case "modules":
        return { modules: [], totalModules: 0 };
      case "stackTrace":
        return this.#stackTrace();
      case "scopes":
        return this.#scopes(Number(args.frameId));
      case "variables":
        return await this.#variables(Number(args.variablesReference));
      case "inspectVariables":
        return { variables: await this.#globals() };
      case "richInspectVariables":
        return await this.#richInspect(String(args.variableName ?? ""), args.frameId);
      case "evaluate":
        return await this.#evaluate(String(args.expression ?? ""), args.frameId);
      case "source":
        return this.#source(args);
      case "continue":
        await this.#command("Debugger.resume");
        return { allThreadsContinued: true };
      case "next":
        await this.#command("Debugger.stepOver");
        return {};
      case "stepIn":
        await this.#command("Debugger.stepInto");
        return {};
      case "stepOut":
        await this.#command("Debugger.stepOut");
        return {};
      case "pause":
        await this.#command("Debugger.pause");
        return {};
      default:
        throw new Error(`unsupported debug command: ${command}`);
    }
  }

  #debugInfo(): CdpParams {
    return {
      isStarted: this.#started,
      hashMethod: "Murmur2",
      hashSeed: HASH_SEED,
      tmpFilePrefix: this.prefix,
      tmpFileSuffix: this.suffix,
      breakpoints: [...this.#breakpoints].map(([source, lines]) => ({ source, breakpoints: lines.map((line) => ({ line })) })),
      stoppedThreads: this.#stopped ? [THREAD_ID] : [],
      richRendering: true,
      exceptionPaths: ["JavaScript Exceptions"],
      copyToGlobals: false,
    };
  }

  async #enable(): Promise<void> {
    const channel = this.#channel;
    if (!channel) return;
    await channel.send("Debugger.enable");
    await channel.send("Debugger.setPauseOnExceptions", { state: this.#pauseOnExceptions });
    this.#cdpBreakpoints.clear();
    for (const path of this.#breakpoints.keys()) await this.#applyBreakpoints(path);
  }

  async #disable(): Promise<void> {
    const channel = this.#channel;
    this.#started = false;
    this.#breakpoints.clear();
    if (channel) {
      for (const ids of this.#cdpBreakpoints.values()) {
        for (const breakpointId of ids) await channel.send("Debugger.removeBreakpoint", { breakpointId }).catch(() => {});
      }
      if (this.#stopped) await channel.send("Debugger.resume").catch(() => {});
      await channel.send("Debugger.disable").catch(() => {});
    }
    this.#cdpBreakpoints.clear();
    this.#resetStop();
  }

  async #setBreakpoints(args: CdpParams): Promise<CdpParams> {
    const source = isRecord(args.source) ? args.source : {};
    const path = String(source.path ?? "");
    const requested = Array.isArray(args.breakpoints) ? args.breakpoints : [];
    const lines = requested.map((b) => Number(isRecord(b) ? b.line : NaN)).filter((n) => Number.isInteger(n) && n > 0);
    if (lines.length > 0) this.#breakpoints.set(path, lines);
    else this.#breakpoints.delete(path);
    if (this.started) await this.#applyBreakpoints(path);
    return { breakpoints: lines.map((line) => ({ verified: true, line, source: { path } })) };
  }

  /** The cell's line map, from its code if it hasn't run yet. */
  #linesFor(path: string): LineMap | null {
    const cell = this.#cells.get(path);
    if (!cell) return null;
    if (cell.lines === null) {
      try {
        cell.lines = transformCellWithLines(cell.code, this.#transformOptions()).lines;
      } catch {
        return null; // a syntax error: the cell won't run anyway
      }
    }
    return cell.lines;
  }

  async #applyBreakpoints(path: string): Promise<void> {
    const channel = this.#channel;
    if (!channel) return;
    for (const breakpointId of this.#cdpBreakpoints.get(path) ?? []) {
      await channel.send("Debugger.removeBreakpoint", { breakpointId }).catch(() => {});
    }
    const ids: string[] = [];
    const lines = this.#linesFor(path);
    for (const line of this.#breakpoints.get(path) ?? []) {
      // A cell not seen yet keeps its line numbers.
      const lineNumber = lines ? lines.toGenerated(line - 1) : line - 1;
      if (lineNumber === null) continue;
      const res = await channel.send("Debugger.setBreakpointByUrl", { url: path, lineNumber });
      if (typeof res.breakpointId === "string") ids.push(res.breakpointId);
    }
    this.#cdpBreakpoints.set(path, ids);
  }

  async #command(method: string): Promise<void> {
    if (!this.#channel) throw new Error("no target to debug");
    await this.#channel.send(method);
  }

  // --- stopped state ----------------------------------------------------------

  #onPaused(params: CdpParams): void {
    this.#frames = Array.isArray(params.callFrames) ? params.callFrames.filter(isCallFrame) : [];
    this.#stopped = true;
    for (const notify of this.#pauseWaiters.splice(0)) notify();
    this.#refs.clear();
    const hit = Array.isArray(params.hitBreakpoints) && params.hitBreakpoints.length > 0;
    const reason = hit
      ? "breakpoint"
      : params.reason === "exception" || params.reason === "promiseRejection"
      ? "exception"
      : params.reason === "other"
      ? "step"
      : String(params.reason ?? "pause");
    this.#event("stopped", { reason, threadId: THREAD_ID, allThreadsStopped: true });
  }

  #resetStop(): void {
    this.#stopped = false;
    this.#frames = [];
    this.#refs.clear();
  }

  /** Cells, and the user's own files; not the runtime's or the kernel's. */
  #userFrame(url: string): boolean {
    if (url.startsWith(this.prefix)) return true;
    if (!url.startsWith("file:")) return false;
    return !/\/runtime\/[^/]+\.mjs$/.test(url) && !url.includes("/node_modules/");
  }

  #stackTrace(): CdpParams {
    const stackFrames = this.#frames.flatMap((frame, id) => {
      const url = this.#scripts.get(frame.location.scriptId) ?? "";
      if (!this.#userFrame(url)) return [];
      const lines = url.startsWith(this.prefix) ? this.#linesFor(url) : null;
      const line = (lines ? lines.toOriginal(frame.location.lineNumber) : frame.location.lineNumber) + 1;
      const path = url.startsWith("file:") ? fileURLToPath(url) : url;
      return [{ id, name: frame.functionName || "<cell>", line, column: (frame.location.columnNumber ?? 0) + 1, source: { path } }];
    });
    return { stackFrames, totalFrames: stackFrames.length };
  }

  #ref(objectId: string, globals = false): number {
    const ref = this.#nextRef++;
    this.#refs.set(ref, { objectId, globals });
    return ref;
  }

  #scopes(frameId: number): CdpParams {
    const frame = this.#frames[frameId];
    if (!frame) throw new Error(`no frame ${frameId}`);
    const scopes = frame.scopeChain.filter((s) => s.object.objectId).map((s) => ({
      name: SCOPE_NAMES[s.type] ?? s.type,
      variablesReference: this.#ref(s.object.objectId ?? "", s.type === "global"),
      expensive: s.type === "global",
    }));
    return { scopes };
  }

  #variable(name: string, value: RemoteObject): CdpParams {
    // Objects and functions can be expanded; primitives can't.
    const expandable = value.objectId !== undefined && (value.type === "object" || value.type === "function");
    return {
      name,
      value: describeRemote(value),
      type: typeOf(value),
      variablesReference: expandable ? this.#ref(value.objectId ?? "") : 0,
    };
  }

  async #variables(reference: number): Promise<CdpParams> {
    const entry = this.#refs.get(reference);
    if (!entry || !this.#channel) return { variables: [] };
    const res = await this.#channel.send("Runtime.getProperties", { objectId: entry.objectId, ownProperties: true });
    const props = Array.isArray(res.result) ? res.result as { name: string; value?: RemoteObject; enumerable?: boolean }[] : [];
    const variables = props
      .filter((p) => p.value !== undefined)
      // The global object's own properties are mostly the runtime's builtins.
      .filter((p) => !entry.globals || (p.enumerable && !this.#channel?.baselineGlobals.has(p.name)))
      .filter((p) => !KERNEL_GLOBALS.has(p.name) && !p.name.startsWith("__cdpk"))
      .map((p) => this.#variable(p.name, p.value as RemoteObject));
    return { variables };
  }

  /**
   * inspectVariables: what the cells have defined. Their top-level
   * declarations (replMode keeps them in the global lexical scope) and the
   * globals they added, each read with V8's side-effect check, so a getter
   * never runs (JupyterLab asks during every cell).
   */
  /**
   * A CDP call's result, or null if the target pauses first: a global
   * evaluation sent just before a breakpoint hits doesn't finish while the
   * target is paused, and the kernel's control requests are answered one at
   * a time, so it would hold up the stackTrace JupyterLab sends next.
   */
  #unlessPaused(call: Promise<CdpParams>): Promise<CdpParams | null> {
    if (this.#stopped) return Promise.resolve(null);
    const paused = new Promise<null>((resolve) => this.#pauseWaiters.push(() => resolve(null)));
    call.catch(() => {}); // settles after the pause, unwatched
    return Promise.race([call, paused]);
  }

  async #globals(): Promise<CdpParams[]> {
    const channel = this.#channel;
    // While paused, the frontend shows the frame's scopes instead.
    if (!channel || this.#stopped) return [];
    const lexical = await this.#unlessPaused(channel.send("Runtime.globalLexicalScopeNames", { executionContextId: channel.contextId }));
    const keys = await this.#unlessPaused(channel.send("Runtime.evaluate", {
      expression: "Object.keys(globalThis)",
      contextId: channel.contextId,
      returnByValue: true,
      throwOnSideEffect: true,
    }));
    if (lexical === null || keys === null) return [];
    const added = Array.isArray((keys.result as RemoteObject | undefined)?.value)
      ? ((keys.result as RemoteObject).value as string[]).filter((n) => !channel.baselineGlobals.has(n))
      : [];
    const names = [...new Set([...(Array.isArray(lexical.names) ? lexical.names.map(String) : []), ...added])]
      .filter((n) => !KERNEL_GLOBALS.has(n) && !n.startsWith("__cdpk"));
    const variables: CdpParams[] = [];
    for (const name of names) {
      const res = await this.#unlessPaused(channel.send("Runtime.evaluate", {
        expression: name,
        contextId: channel.contextId,
        throwOnSideEffect: true,
      }));
      if (res === null) return [];
      if (!res.exceptionDetails && isRemoteObject(res.result)) variables.push(this.#variable(name, res.result));
    }
    return variables;
  }

  /** An expression's value: in a paused frame, or globally (side-effect free). */
  async #valueOf(expression: string, frameId: unknown, pure: boolean): Promise<RemoteObject> {
    const channel = this.#channel;
    if (!channel) throw new Error("no target to debug");
    // While paused, only a frame can evaluate: use the top one if none was named.
    const frame = typeof frameId === "number" ? this.#frames[frameId] : this.#stopped ? this.#frames[0] : undefined;
    // replMode (for the console's `await`) returns a promise the inspector
    // holds only weakly: SETTLE closes that window, as for cells (#55). A
    // side-effect-free lookup can't await, so it uses a plain evaluate.
    const res = frame
      ? await channel.send("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId, expression, throwOnSideEffect: pure })
      : pure
      ? await channel.send("Runtime.evaluate", { expression, contextId: channel.contextId, throwOnSideEffect: true })
      : await this.#withoutPausing(() =>
        channel.send("Runtime.evaluate", { expression: expression + SETTLE, contextId: channel.contextId, replMode: true })
      );
    if (isRecord(res.exceptionDetails)) {
      const exception = res.exceptionDetails.exception as RemoteObject | undefined;
      throw new Error(exception ? describeRemote(exception) : String(res.exceptionDetails.text ?? "evaluation failed"));
    }
    if (!isRemoteObject(res.result)) throw new Error("the target returned no value");
    return res.result;
  }

  async #evaluate(expression: string, frameId: unknown): Promise<CdpParams> {
    const value = await this.#valueOf(expression, frameId, false);
    const variable = this.#variable(expression, value);
    return { result: variable.value, type: variable.type, variablesReference: variable.variablesReference };
  }

  /** The rich variable viewer: the value's MIME bundle, as a cell would display it. */
  async #richInspect(name: string, frameId: unknown): Promise<CdpParams> {
    const channel = this.#channel;
    if (!channel) throw new Error("no target to debug");
    const value = await this.#valueOf(name, frameId, true);
    const arg = value.objectId ? { objectId: value.objectId } : { value: value.value };
    // Synchronous: while the target is paused, no promise would settle.
    const res = await this.#withoutPausing(() =>
      channel.send("Runtime.callFunctionOn", {
        functionDeclaration: "function (v) { return globalThis.__cdpk.richBundle(v); }",
        arguments: [arg],
        executionContextId: channel.contextId,
        returnByValue: true,
      })
    );
    const text = (res.result as RemoteObject | undefined)?.value;
    const data: unknown = typeof text === "string" ? JSON.parse(text) : {};
    return { data: isRecord(data) ? data : {}, metadata: {} };
  }

  #source(args: CdpParams): CdpParams {
    const source = isRecord(args.source) ? args.source : {};
    const path = String(source.path ?? "");
    const cell = this.#cells.get(path);
    if (cell) return { content: cell.code };
    try {
      return { content: readFileSync(path, "utf8") };
    } catch {
      throw new Error("source unavailable");
    }
  }

  #writeCell(path: string, code: string): void {
    try {
      if (!this.#cleanupRegistered) {
        // The files only serve this kernel's frontend: remove them with it.
        process.once("exit", () => rmSync(this.prefix, { recursive: true, force: true }));
        this.#cleanupRegistered = true;
      }
      mkdirSync(this.prefix, { recursive: true });
      writeFileSync(path, code);
    } catch {
      // The frontend has the cell itself; the file is a convenience.
    }
  }

  /** The kernel's own evaluation, unpaused by exceptions; while stopped, nothing more pauses anyway. */
  #withoutPausing<T>(call: () => Promise<T>): Promise<T> {
    const channel = this.#channel;
    return channel?.withoutPausing && !this.#stopped ? channel.withoutPausing(call) : call();
  }

  #event(event: string, body: CdpParams): void {
    const message = { type: "event", seq: ++this.#seq, event, body };
    trace("event", message);
    this.#emit(message);
  }
}
