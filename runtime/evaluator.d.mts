/** The parts of globalThis.__cdpk the evaluator calls. */
export interface EvaluatorShim {
  broadcastResult(executionCount: number, value: unknown): void | Promise<void>;
  describeError(value: unknown): string;
  commDispatch(msgType: string, content: object, metadata: object, buffers64: string[]): Promise<unknown>;
  barrier(): number;
}

/** A request from the host: an `op` plus its parameters. */
export interface EvaluatorRequest {
  op: string;
  [key: string]: unknown;
}

export type Handler = (request: EvaluatorRequest) => Promise<{ [key: string]: unknown }>;

export function propertyNames(value: unknown): string[];
export function createHandler(shim: EvaluatorShim, evaluate?: (code: string) => unknown): Handler;
