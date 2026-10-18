// The browser target: cells run in a module Web Worker
// (runtime/browser-worker.mjs) that the page creates. Requests and replies
// are messages, in the shape of the workerd target's session
// (src/workerd-target.ts), whose request and interrupt handling this
// follows. Cells are transformed as for Bun and workerd
// (transformCellForEval).

import { asEvaluateResult, type CdpParams, type EvaluateResult, isRecord, type RemoteObject } from "../cdp.ts";
import { Interrupted, isTargetMessage, type KernelTarget, type TargetEvents } from "../target-api.ts";
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
}

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
  #nextId = 0;
  #interrupted = false;
  #stopNote: string | undefined;
  #exited = false;

  private constructor(worker: WorkerLike, events: TargetEvents) {
    this.#worker = worker;
    this.#events = events;
    worker.addEventListener("message", (event) => this.#receive(event.data));
    // A driver that failed to load: what's pending can't be answered.
    worker.addEventListener("error", (event) => {
      this.#events.stream("stderr", `[cdp-kernel] browser Worker error: ${event.message ?? "unknown"}\n`);
      this.#exit(null);
    });
  }

  static async launch(events: TargetEvents, options: BrowserTargetOptions): Promise<BrowserTarget> {
    const target = new BrowserTarget(options.createWorker(), events);
    const base = options.base ?? globalThis.location?.href ?? "file:///";
    try {
      const { userAgent } = await target.#request("info", { base, cdn: options.cdn });
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

  #exit(code: number | null): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#worker.terminate();
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
   * ping, and the cell is abandoned with its state intact. A busy cell
   * can't be reached, so the Worker is terminated, and a new one starts on
   * the next cell.
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
