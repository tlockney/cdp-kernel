// The browser target: cells run in a module Web Worker
// (runtime/browser-worker.mjs) that the page creates. Requests and replies
// are messages, in the shape of the workerd target's session
// (src/workerd-target.ts), whose request and interrupt handling this
// follows. Cells are transformed as for Bun and workerd
// (transformCellForEval).

import { asEvaluateResult, type CdpParams, type EvaluateResult, isRecord, type RemoteObject } from "../cdp.ts";
import { Interrupted, isTargetMessage, type KernelTarget, parseBundle, type TargetEvents } from "../target-api.ts";
import { transformCellForEval } from "../transform.ts";

/** See BunTarget: how long an interrupted cell has to show it isn't busy. */
export const INTERRUPT_GRACE_MS = 500;

export const RESTART_NOTE = "[cdp-kernel] the browser target was busy and can't be interrupted in place, so its " +
  "Worker was stopped; a new one starts on the next cell, without the earlier cells' state";

/** The part of a Worker the target uses, so tests can stand in for one. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
  terminate(): void;
}

export interface BrowserTargetOptions {
  /** Makes the driver Worker: e.g. `new Worker(url, { type: "module" })`. */
  createWorker(): WorkerLike;
  /** What relative imports and import.meta.url resolve against; the page's URL by default. */
  base?: string;
  /** Where npm:, jsr: and bare imports load from; esm.sh by default. */
  cdn?: string;
  /**
   * Modules the Worker imports before the first cell, each time it starts,
   * resolved against `base`. A module's default export, if a function, is
   * called with `{ host, jupyter }` (#384).
   */
  preload?: string[];
  /** Answers the Worker's `host.request` calls; without it they reject (#384). */
  host?: HostHandler;
}

/** A request a preload module made with `host.request(method, params)`. */
export interface HostRequest {
  method: string;
  params: unknown;
}

/**
 * Resolves with the value `host.request` resolves with in the Worker, or
 * rejects, and the Worker's promise rejects with an Error carrying the
 * thrown error's `name`, `message` and `code`. `signal` aborts when the
 * Worker cancels the call or stops.
 */
export type HostHandler = (request: HostRequest, signal: AbortSignal) => unknown;

/** Rejects a request whose reply the target no longer waits for. */
class Abandoned extends Error {}

type Pending = { resolve: (reply: CdpParams) => void; reject: (err: Error) => void };

export class BrowserTarget implements KernelTarget {
  readonly runtime = "browser" as const;
  readonly versions: { runtime: string; engine: string } = { runtime: "", engine: "" };
  readonly transform = transformCellForEval;
  readonly #worker: WorkerLike;
  readonly #events: TargetEvents;
  readonly #pending = new Map<number, Pending>();
  /** Requests that interrupt() abandons when the driver can still answer. */
  readonly #interruptible = new Set<number>();
  /** Host requests in flight, by the Worker's id (#384). */
  readonly #hostCalls = new Map<number, AbortController>();
  readonly #host: HostHandler | undefined;
  #nextId = 0;
  #interrupted = false;
  #stopNote: string | undefined;
  #exited = false;

  private constructor(worker: WorkerLike, events: TargetEvents, host: HostHandler | undefined) {
    this.#worker = worker;
    this.#events = events;
    this.#host = host;
    worker.addEventListener("message", (event) => this.#receive(event.data));
    // A driver that failed to load: what's pending can't be answered.
    worker.addEventListener("error", (event) => {
      this.#events.stream("stderr", `[cdp-kernel] browser Worker error: ${event.message ?? "unknown"}\n`);
      this.#exit(null);
    });
  }

  static async launch(events: TargetEvents, options: BrowserTargetOptions): Promise<BrowserTarget> {
    const target = new BrowserTarget(options.createWorker(), events, options.host);
    const base = options.base ?? globalThis.location?.href ?? "file:///";
    try {
      const { userAgent } = await target.#request("info", { base, cdn: options.cdn, preload: options.preload ?? [] });
      if (typeof userAgent === "string") target.versions.runtime = browserName(userAgent);
      target.versions.engine = engineName(typeof userAgent === "string" ? userAgent : "");
    } catch (err) {
      target.kill();
      throw err;
    }
    return target;
  }

  #receive(msg: unknown): void {
    if (isRecord(msg) && msg.kind === "stream") {
      this.#events.stream(msg.name === "stderr" ? "stderr" : "stdout", String(msg.text));
    } else if (isRecord(msg) && msg.kind === "host") {
      this.#hostRequest(msg);
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

  #hostRequest(msg: CdpParams): void {
    const id = Number(msg.id);
    if (msg.cancel === true) {
      this.#hostCalls.get(id)?.abort();
      this.#hostCalls.delete(id);
      return;
    }
    const controller = new AbortController();
    this.#hostCalls.set(id, controller);
    const answer = (reply: CdpParams) => {
      if (this.#hostCalls.get(id) !== controller) return; // cancelled, or the Worker stopped
      this.#hostCalls.delete(id);
      try {
        this.#worker.postMessage({ op: "host", id, ...reply });
      } catch (err) {
        // A result structured clone can't copy, such as a function.
        this.#worker.postMessage({ op: "host", id, error: describeHostError(err) });
      }
    };
    const host = this.#host;
    new Promise((resolve) => {
      if (!host) throw new Error("this page offers no host requests");
      resolve(host({ method: String(msg.method), params: msg.params }, controller.signal));
    }).then(
      (result) => answer({ result }),
      (err) => answer({ error: describeHostError(err) }),
    );
  }

  /** Aborts each host request in flight and rejects it in the Worker. */
  #cancelHostCalls(): void {
    const calls = [...this.#hostCalls];
    this.#hostCalls.clear();
    for (const [id, controller] of calls) {
      controller.abort();
      this.#worker.postMessage({ op: "host", id, error: { name: "AbortError", message: "interrupted" } });
    }
  }

  /** Sends `host.onEvent` listeners in the Worker an event (#384). */
  notifyHost(event: string, value?: unknown): void {
    if (!this.#exited) this.#worker.postMessage({ op: "host", event, value });
  }

  #exit(code: number | null): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#worker.terminate();
    for (const controller of this.#hostCalls.values()) controller.abort();
    this.#hostCalls.clear();
    // Reported before the requests it cut off fail, so the note lands in
    // the interrupted cell's output.
    this.#events.exit(code, this.#stopNote);
    for (const pending of this.#pending.values()) pending.reject(new Abandoned("the browser Worker stopped"));
    this.#pending.clear();
  }

  #request(op: string, params: CdpParams = {}, interruptible = false): Promise<CdpParams> {
    if (this.#exited) return Promise.reject(new Abandoned("the browser Worker stopped"));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      if (interruptible) this.#interruptible.add(id);
      this.#worker.postMessage({ id, op, ...params });
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
    return asEvaluateResult(await this.#interruptibly("eval", { code: script }, "Execution"));
  }

  /**
   * A cell that's waiting on something leaves the Worker free: it answers a
   * ping, and the cell is abandoned with its state intact; host requests
   * in flight are cancelled on the page, and reject in the Worker with an
   * AbortError (#388). A busy cell can't be reached, so the Worker is
   * terminated, and a new one starts on the next cell.
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
      this.#cancelHostCalls();
      return;
    }
    this.#stopNote = RESTART_NOTE;
    this.#exit(null);
  }

  /** Output arrives before the reply it precedes. */
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
    const reply = await this.#interruptibly("comm", { msgType, content, metadata, buffers: buffers.map(toBase64) }, "Comm handler");
    if (isRecord(reply.error)) {
      const { name, message, stack } = reply.error;
      return { error: { name: String(name), message: String(message), stack: String(stack) } };
    }
    return { handled: reply.handled === true };
  }

  async format(value: RemoteObject): Promise<CdpParams> {
    const reply = await this.#request("format", { handle: value.objectId });
    return parseBundle(reply.value);
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

  /** Resolved by property descriptor in the Worker, so nothing runs (#10). */
  async inspect(path: string, detail: number): Promise<string | null> {
    const reply = await this.#request("inspect", { path, detail }).catch(() => null);
    return typeof reply?.text === "string" ? reply.text : null;
  }

  /** None: top-level declarations here are properties of globalThis. */
  lexicalNames(): Promise<string[]> {
    return Promise.resolve([]);
  }

  /** Never asked for: prompt() in the Worker answers null without asking. */
  replyInput(): void {}

  kill(): void {
    this.#exit(null);
  }
}

function describeHostError(err: unknown): CdpParams {
  if (isRecord(err)) {
    const { name, message, code } = err;
    return {
      name: typeof name === "string" ? name : "Error",
      message: typeof message === "string" ? message : String(err),
      ...(code === undefined ? {} : { code: code as CdpParams[string] }),
    };
  }
  return { name: "Error", message: String(err) };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** "Chrome 141", "Firefox 144", "Safari 26": the browser and its major version. */
export function browserName(userAgent: string): string {
  for (const [name, re] of [
    ["Edge", /\bEdg\/(\d+)/],
    ["Firefox", /\bFirefox\/(\d+)/],
    ["Chrome", /\b(?:Headless)?Chrome\/(\d+)/],
    ["Safari", /\bVersion\/(\d+)[\d.]* .*Safari\//],
  ] as const) {
    const m = re.exec(userAgent);
    if (m) return `${name} ${m[1]}`;
  }
  return "a browser";
}

function engineName(userAgent: string): string {
  if (/\bFirefox\//.test(userAgent)) return "SpiderMonkey";
  if (/\b(?:Chrome|Chromium|Edg)\//.test(userAgent)) return "V8";
  if (/\bSafari\//.test(userAgent)) return "JavaScriptCore";
  return "";
}
