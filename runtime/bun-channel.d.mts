/** The parts of globalThis.__cdpk (bootstrap.mjs) the channel calls. */
export interface ChannelShim {
  broadcastResult(executionCount: number, value: unknown): void | Promise<void>;
  describeError(value: unknown): string;
  commDispatch(msgType: string, content: object, metadata: object, buffers64: string[]): Promise<unknown>;
  barrier(): number;
}

/** A request from the host: an `op` plus its parameters. */
export interface ChannelRequest {
  op: string;
  [key: string]: unknown;
}

export function propertyNames(value: unknown): string[];
export function createHandler(
  shim: ChannelShim,
  evaluate?: (code: string) => unknown,
): (request: ChannelRequest) => Promise<{ [key: string]: unknown }>;
export function startChannel(
  handle: (request: ChannelRequest) => Promise<{ [key: string]: unknown }>,
  ready: { [key: string]: unknown },
  fd?: number,
): void;
