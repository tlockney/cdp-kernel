import type { CommApi } from "./comm.d.mts";
import type { $display, MediaBundle } from "./display.d.mts";

export const WIDGET_PROTOCOL_VERSION: "2.1.0";

export type WidgetState = { [key: string]: unknown };

export interface WidgetOptions {
  /** The anywidget ES module: `export default { render({ model, el }) { ... } }`. */
  esm: string;
  /** Optional CSS for the view. */
  css?: string;
  /** Initial synced state. Uint8Array/ArrayBuffer values travel as binary buffers. */
  state?: WidgetState;
}

/** An anywidget model, synced with its frontend views. Display it to show a view. */
export interface Widget {
  /** The model id (the comm id). */
  readonly id: string;
  readonly closed: boolean;
  get(key: string): unknown;
  /** Sets one key or several, and syncs the change to the frontend. */
  set(key: string, value: unknown): void;
  set(changes: WidgetState): void;
  on(event: `change:${string}`, listener: (value: unknown, previous: unknown) => void | Promise<void>): void;
  on(event: "change", listener: (changes: WidgetState) => void | Promise<void>): void;
  on(event: "msg:custom", listener: (content: unknown, buffers: Uint8Array[]) => void | Promise<void>): void;
  off(event: string, listener: (...args: never[]) => unknown): void;
  /** A custom message to the view's `model.on("msg:custom", ...)`. */
  send(content: unknown, buffers?: Uint8Array[]): void;
  close(): void;
  fullState(): WidgetState;
  /** Displaying a widget shows a view of it (application/vnd.jupyter.widget-view+json). */
  [$display](): MediaBundle;
}

export function removeBuffers(state: unknown): { state: unknown; bufferPaths: (string | number)[][]; buffers: Uint8Array[] };
export function putBuffers<T>(state: T, bufferPaths?: (string | number)[][], buffers?: Uint8Array[]): T;
export function createWidgetFactory(commApi: CommApi, $display: symbol): (options: WidgetOptions) => Widget;
