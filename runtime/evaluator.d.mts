/** The parts of globalThis.__cdpk the evaluator calls. */
export interface EvaluatorShim {
  broadcastResult(executionCount: number, value: unknown): void | Promise<void>;
  describeError(value: unknown): string;
  commDispatch(msgType: string, content: object, metadata: object, buffers64: string[]): Promise<unknown>;
  barrier(): number;
  /** inspect_request's text for a dotted path, or null (#10). */
  inspectPath(path: string, detail: number): string | null;
  /** Resolves a dotted path without running getters; see introspect.mjs. */
  resolvePath?(path: string): import("./introspect.mjs").Resolved;
}

/** A request from the host: an `op` plus its parameters. */
export interface EvaluatorRequest {
  op: string;
  [key: string]: unknown;
}

export type Handler = (request: EvaluatorRequest) => Promise<{ [key: string]: unknown }>;

export function propertyNames(value: unknown): string[];
export function createHandler(shim: EvaluatorShim, evaluate?: (code: string) => unknown): Handler;
