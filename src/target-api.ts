// What the kernel needs from a target runtime, and what a target sends
// back: the part of src/target.ts with no Node imports, so the kernel's
// message handling (src/kernel-core.ts) also loads in a browser.

import type { CdpParams, EvaluateResult, RemoteObject } from "./cdp.ts";
import type { DebugChannel } from "./debugger.ts";
import type { CellTransformOptions } from "./transform.ts";

/** Targets driven over CDP. */
export type CdpRuntime = "node" | "deno";
/** Bun, workerd and celld have their own backends: src/bun-target.ts, src/workerd-target.ts, src/celld-target.ts. */
export type RuntimeName = CdpRuntime | "bun" | "workerd" | "celld";

/** Every target: the runtimes a kernelspec names, and the browser's Worker (src/browser/). */
export type TargetRuntime = RuntimeName | "browser";

/** What the kernel needs from a target runtime. */
export interface KernelTarget {
  readonly runtime: TargetRuntime;
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
  /** A value's MIME bundle, as a cell's result would show it: for user_expressions (#340). */
  format(value: RemoteObject): Promise<CdpParams>;
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
  /** Answers the target's pending prompt; `interrupted` makes it throw instead (#121). */
  replyInput(value: string | null, interrupted?: boolean): void;
  /** What the host waits on, for a kernel that has stopped answering (#237). */
  diagnose?(): Promise<CdpParams>;
  /** Lets go of the last cell's result and error, once they are shown (#286). */
  releaseResults?(): Promise<void>;
  kill(): void;
}

/** Messages the bootstrap sends: message records on stdout, or Bun's channel. */
export type TargetMessage =
  | { kind: "iopub"; msg_type: string; content: CdpParams; metadata: CdpParams; buffers: string[]; barrier: number }
  | { kind: "input_request"; prompt: string; password: boolean; barrier: number };

/** A MIME bundle the target sent as JSON text; empty if it isn't one. */
export function parseBundle(text: unknown): CdpParams {
  const bundle = typeof text === "string" ? parseJson(text) : undefined;
  return typeof bundle === "object" && bundle !== null && !Array.isArray(bundle) ? bundle as CdpParams : {};
}

/** How long a target may take from launch to a usable session. */
export const START_TIMEOUT_MS = 60_000;

/**
 * `start`, or a rejection once `ms` pass without it settling. The caller
 * stops whatever was starting: a runtime that never becomes ready would
 * otherwise wedge the first cell (#52, #336).
 */
export async function withStartTimeout<T>(start: Promise<T>, what: string, ms: number = START_TIMEOUT_MS): Promise<T> {
  // Its own rejection, once the deadline has passed, is the caller's to ignore.
  start.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not start within ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([start, stalled]);
  } finally {
    clearTimeout(timer);
  }
}

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

export interface TargetEvents {
  stream(name: "stdout" | "stderr", text: string): void;
  message(msg: TargetMessage): void;
  /** `note` says why, when the target was stopped on purpose. */
  exit(code: number | null, note?: string): void;
}

export class Interrupted extends Error {
  override name = "Interrupted";
}
