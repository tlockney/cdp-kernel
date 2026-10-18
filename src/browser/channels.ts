// KernelChannels inside a page: the frontend hands the kernel messages in
// Jupyter's JSON shape (as the websocket's JSON protocol and
// @jupyterlab/services carry them) and gets messages back the same way.
// There is one frontend, so one peer, and no signing.

import type { ChannelName, KernelChannels, Received } from "../kernel-core.ts";
import type { JsonObject, OutgoingMessage, ReceivedHeader } from "../message.ts";

/** Every channel a message travels on, iopub included. */
export type Channel = ChannelName | "iopub";

/** A Jupyter message as JSON, the shape a frontend sends and receives. */
export interface JupyterMessage {
  header: JsonObject;
  parent_header: JsonObject;
  metadata: JsonObject;
  content: JsonObject;
  buffers?: (ArrayBuffer | ArrayBufferView)[];
  channel?: string;
}

export type MessageListener = (channel: Channel, msg: JupyterMessage) => void;

const PEER = "page";

class Queue<T> {
  #items: T[] = [];
  #waiters: ((item: T) => void)[] = [];
  get size(): number {
    return this.#items.length;
  }
  push(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(item);
    else this.#items.push(item);
  }
  pop(): Promise<T> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

function bytes(buffer: ArrayBuffer | ArrayBufferView): Uint8Array {
  return buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function isHeader(value: JsonObject): value is ReceivedHeader {
  return typeof value.msg_id === "string" && typeof value.msg_type === "string";
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class PageChannels implements KernelChannels {
  readonly ready: Promise<unknown> = Promise.resolve();
  readonly #queues: Record<ChannelName, Queue<Received | null>> = { shell: new Queue(), control: new Queue(), stdin: new Queue() };
  readonly #listeners = new Set<MessageListener>();

  /** A message from the frontend. One without a msg_id and msg_type is dropped. */
  deliver(channel: ChannelName, msg: JupyterMessage): void {
    const { header, parent_header: parentHeader, metadata, content } = msg;
    const valid = isObject(header) && isHeader(header) && isObject(content);
    this.#queues[channel].push(valid
      ? {
        peer: PEER,
        msg: {
          header,
          parentHeader: isObject(parentHeader) ? parentHeader : {},
          metadata: isObject(metadata) ? metadata : {},
          content,
          buffers: (msg.buffers ?? []).map(bytes),
        },
      }
      : null);
  }

  onMessage(listener: MessageListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(channel: Channel, msg: OutgoingMessage): void {
    const out: JupyterMessage = {
      channel,
      header: msg.header,
      parent_header: msg.parentHeader,
      metadata: msg.metadata,
      content: msg.content,
      buffers: msg.buffers,
    };
    for (const listener of this.#listeners) listener(channel, out);
  }

  recv(channel: ChannelName): Promise<Received | null> {
    return this.#queues[channel].pop();
  }

  shellQueued(): number {
    return this.#queues.shell.size;
  }

  reply(channel: ChannelName, _peer: string, msg: OutgoingMessage): void {
    this.#emit(channel, msg);
  }

  publish(msg: OutgoingMessage): void {
    this.#emit("iopub", msg);
  }

  stdinPeers(): number {
    return 1;
  }

  sendStdin(msg: OutgoingMessage): void {
    this.#emit("stdin", msg);
  }
}
