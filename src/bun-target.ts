// The Bun target (#7). Bun's --inspect speaks the WebKit Inspector Protocol,
// which has no replMode, Runtime.addBinding or Runtime.terminateExecution, so
// Bun isn't driven over an inspector at all. The host sends requests over a
// private pipe (fd 3) to runtime/bun-channel.mjs, which evaluates cells
// in-process (transformCellForEval). Output ordering is the CDP targets':
// stdout and stderr are pipes, ordered against channel messages by the
// bootstrap's barrier markers.

import { Buffer } from "node:buffer";
import process from "node:process";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { CdpParams, EvaluateResult, RemoteObject } from "./cdp.ts";
import { transformCellForEval } from "./transform.ts";
import { runtimeDir } from "./package.ts";
import { killOnExit } from "./children.ts";
import { Gates, Interrupted, isTargetMessage, type KernelTarget, parseJson, PipeDemux, type TargetEvents, type TargetMessage } from "./target.ts";

/**
 * How long an interrupted target has to answer a ping. A cell waiting on a
 * promise leaves the event loop free, so the answer is near-instant; a busy
 * one can't answer at all.
 */
export const INTERRUPT_GRACE_MS = 500;

export const RESTART_NOTE =
  "[cdp-kernel] bun was busy and can't be interrupted in place, so it was stopped; " +
  "it restarts on the next cell, without the earlier cells' state";

/** Rejects a request whose reply the host no longer waits for. */
class Abandoned extends Error {}

type Pending = { resolve: (reply: CdpParams) => void; reject: (err: Error) => void };

function isDuplex(stream: unknown): stream is Duplex {
  return typeof (stream as Duplex | null)?.write === "function" && typeof (stream as Duplex | null)?.on === "function";
}

function isRecord(value: unknown): value is CdpParams {
  return typeof value === "object" && value !== null;
}

export function bunLaunchCommand(bootstrap: string, executable?: string): { cmd: string; args: string[] } {
  // No flags: Bun reads the notebook directory's bunfig.toml and package.json
  // on its own, and auto-installs bare imports when there's no node_modules.
  return { cmd: executable ?? "bun", args: [bootstrap] };
}

export class BunTarget implements KernelTarget {
  readonly runtime = "bun";
  readonly versions = { runtime: "", engine: "" };
  readonly transform = transformCellForEval;
  readonly #child: ChildProcess;
  readonly #channel: Duplex;
  readonly #stdout: PipeDemux;
  readonly #stderr: PipeDemux;
  readonly #gates = new Gates();
  readonly #pending = new Map<number, Pending>();
  #nextId = 0;
  #exitedOnce = false;
  #messages: Promise<void> = Promise.resolve();
  #interrupted = false;
  #stopNote: string | undefined;

  private constructor(child: ChildProcess, channel: Duplex, events: TargetEvents) {
    this.#child = child;
    this.#channel = channel;
    this.#stdout = new PipeDemux((text) => events.stream("stdout", text), (n) => this.#gates.wait(n));
    this.#stderr = new PipeDemux((text) => events.stream("stderr", text), (n) => this.#gates.wait(n));
  }

  static async launch(events: TargetEvents, options: { cwd?: string; executable?: string } = {}): Promise<BunTarget> {
    const bootstrap = join(await runtimeDir(new URL("../runtime/", import.meta.url).href), "bootstrap.mjs");
    const { cmd, args } = bunLaunchCommand(bootstrap, options.executable);
    const env: Record<string, string | undefined> = { ...process.env, FORCE_COLOR: "1" };
    delete env.NO_COLOR;
    const child = spawn(cmd, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe", "pipe"], env });
    killOnExit(child);
    const channel = child.stdio[3];
    if (!child.stdout || !child.stderr || !isDuplex(channel)) {
      child.kill();
      throw new Error("could not open the pipes to bun");
    }
    const target = new BunTarget(child, channel, events);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => target.#stdout.push(chunk));

    const ready = new Promise<CdpParams>((resolve, reject) => {
      let early = "";
      const onEarly = (chunk: string) => (early += chunk);
      child.stderr?.on("data", onEarly);
      target.#onReady = (msg) => {
        child.stderr?.off("data", onEarly);
        if (early) target.#stderr.push(early);
        child.stderr?.on("data", (chunk: string) => target.#stderr.push(chunk));
        resolve(msg);
      };
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`${cmd} exited (${code}) before it was ready:\n${early}`)));
    });
    target.#readChannel(events);
    child.once("exit", (code) => target.#exited(code, events));

    const { versions } = await ready;
    if (isRecord(versions)) Object.assign(target.versions, versions);
    return target;
  }

  #onReady: (msg: CdpParams) => void = () => {};

  #readChannel(events: TargetEvents): void {
    let buffer = "";
    this.#channel.setEncoding("utf8");
    this.#channel.on("data", (chunk: string) => {
      buffer += chunk;
      for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
        // Cells can write here through __cdpk_send too (#122).
        const msg = parseJson(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (isTargetMessage(msg)) this.#deliver(msg, events);
        else if (isRecord(msg) && msg.kind === "reply") this.#settle(msg);
        else if (isRecord(msg) && msg.kind === "ready") this.#onReady(msg);
      }
    });
    // A closed pipe is reported through the child's exit.
    this.#channel.on("error", () => {});
  }

  #settle(reply: CdpParams): void {
    const id = Number(reply.id);
    const pending = this.#pending.get(id);
    if (!pending) return; // abandoned
    this.#pending.delete(id);
    if (typeof reply.failure === "string") pending.reject(new Error(reply.failure));
    else pending.resolve(reply);
  }

  #exited(code: number | null, events: TargetEvents): void {
    this.#exitedOnce = true;
    this.#gates.openAll();
    this.#stdout.close();
    this.#stderr.close();
    events.exit(code, this.#stopNote);
    this.#abandonPending(`bun exited (${code})`);
  }

  #abandonPending(reason: string): void {
    for (const pending of this.#pending.values()) pending.reject(new Abandoned(reason));
    this.#pending.clear();
  }

  // Binding messages wait until both pipes have caught up to their marker,
  // and are delivered strictly in order (as in Target).
  #deliver(msg: TargetMessage, events: TargetEvents): void {
    this.#messages = this.#messages.then(async () => {
      await Promise.all([this.#stdout.waitFor(msg.barrier), this.#stderr.waitFor(msg.barrier)]);
      events.message(msg);
      this.#gates.open(msg.barrier);
    });
  }

  #request(op: string, params: CdpParams = {}): Promise<CdpParams> {
    // Bun is gone; a write to its channel would never be answered.
    if (this.#exitedOnce) return Promise.reject(new Abandoned("the bun session is closed"));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#channel.write(JSON.stringify({ id, op, ...params }) + "\n");
    });
  }

  /** A request that interrupt() may cut short. */
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
    return (await this.#interruptible("eval", { code: script }, "Execution")) as unknown as EvaluateResult;
  }

  /**
   * There's no terminateExecution, but a cell that's waiting on a promise
   * leaves the event loop free: the target answers a ping, and the cell is
   * abandoned with the session intact, like terminateExecution on an idle
   * isolate (its pending work still runs). A busy cell can't be reached, so
   * the process is stopped and restarts on the next cell, losing its state.
   */
  async interrupt(): Promise<void> {
    this.#interrupted = true;
    const answered = await Promise.race([
      this.#request("ping").then(() => true, () => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), INTERRUPT_GRACE_MS)),
    ]);
    if (answered) {
      this.#abandonPending("interrupted");
      return;
    }
    this.#stopNote = RESTART_NOTE;
    this.#child.kill("SIGKILL");
  }

  async flush(): Promise<void> {
    const { value } = await this.#request("barrier");
    const barrier = Number(value);
    await Promise.all([this.#stdout.waitFor(barrier), this.#stderr.waitFor(barrier)]);
    await this.#messages;
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

  /** Resolved by property descriptor in the target, so nothing runs (#10). */
  async inspect(path: string, detail: number): Promise<string | null> {
    const reply = await this.#request("inspect", { path, detail }).catch(() => null);
    return typeof reply?.text === "string" ? reply.text : null;
  }

  /** None: top-level declarations here are properties of globalThis. */
  lexicalNames(): Promise<string[]> {
    return Promise.resolve([]);
  }

  replyInput(value: string | null): void {
    this.#child.stdin?.write(JSON.stringify({ value }) + "\n");
  }

  kill(): void {
    this.#child.kill();
  }
}
