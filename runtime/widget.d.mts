import type { CommApi } from "./comm.d.mts";
import type { $display, MediaBundle } from "./display.d.mts";

export const WIDGET_PROTOCOL_VERSION: "2.1.0";

export type WidgetState = { [key: string]: unknown };

/** Options for `jupyter.widget`. */
export interface WidgetOptions {
  /**
   * The anywidget view module, as source:
   * `export default { render({ model, el }) { ... } }`. A `${...}` inside
   * a template literal here is filled in by the kernel, not the browser:
   * escape it as `\${...}`.
   */
  esm: string;
  /** CSS for the view. */
  css?: string;
  /**
   * The initial synced state. `Uint8Array` and `ArrayBuffer` values travel
   * as binary buffers. Default `{}`.
   */
  state?: WidgetState;
}

/**
 * An anywidget model, from `jupyter.widget`, synced with its frontend
 * views. Display it to show a view; display it again for a second view of
 * the same model.
 */
export interface Widget {
  /** The model id (the comm id). */
  readonly id: string;
  /** Whether the model has been closed. */
  readonly closed: boolean;
  /**
   * The current value of a state key.
   *
   * @param key The state key.
   * @returns Its value, or `undefined`.
   * @example
   * ```ts
   * const w = jupyter.widget({ esm: "export default {}", state: { count: 0 } });
   * w.get("count"); // 0
   * ```
   */
  get(key: string): unknown;
  /**
   * Change one state key, or several at once, and sync the change to every
   * view. Fires this model's own `change` listeners too. After `close` it
   * changes the local state only.
   *
   * @param key The state key.
   * @param value Its new value.
   * @param changes Several keys and their new values, instead of `key` and
   *   `value`.
   * @example
   * ```ts
   * const w = jupyter.widget({ esm: "export default {}", state: { count: 0, label: "" } });
   * w.set("count", 1);
   * w.set({ count: 2, label: "two" });
   * ```
   */
  set(key: string, value: unknown): void;
  set(changes: WidgetState): void;
  /**
   * Listen for state changes or custom messages from the views.
   * `change:key` gets the new and previous value; `change` gets all the
   * changed keys; `msg:custom` gets a view's `model.send` content.
   *
   * @param event `change:<key>`, `change` or `msg:custom`.
   * @param listener Called for each event; may be async.
   * @example
   * ```ts
   * const w = jupyter.widget({ esm: "export default {}", state: { count: 0 } });
   * w.on("change:count", (value, previous) => console.log(previous, "->", value));
   * w.on("msg:custom", (content) => console.log("view sent", content));
   * ```
   */
  on(event: `change:${string}`, listener: (value: unknown, previous: unknown) => void | Promise<void>): void;
  on(event: "change", listener: (changes: WidgetState) => void | Promise<void>): void;
  on(event: "msg:custom", listener: (content: unknown, buffers: Uint8Array[]) => void | Promise<void>): void;
  /**
   * Remove a listener added with `on`.
   *
   * @param event The event it was added for.
   * @param listener The same function.
   * @example
   * ```ts
   * const w = jupyter.widget({ esm: "export default {}", state: { count: 0 } });
   * const log = (value: unknown) => console.log(value);
   * w.on("change:count", log);
   * w.off("change:count", log);
   * ```
   */
  off(event: string, listener: (...args: never[]) => unknown): void;
  /**
   * Send a custom message to every view's `model.on("msg:custom", ...)`.
   *
   * @param content JSON content.
   * @param buffers Binary buffers. Default `[]`.
   * @example
   * ```ts
   * const w = jupyter.widget({ esm: "export default {}" });
   * w.send({ type: "reset" });
   * ```
   */
  send(content: unknown, buffers?: Uint8Array[]): void;
  /**
   * Close the model. Its views stop syncing.
   *
   * @example
   * ```ts
   * const w = jupyter.widget({ esm: "export default {}" });
   * w.close();
   * ```
   */
  close(): void;
  /**
   * The full state, as the frontend sees it.
   *
   * @returns Every state key and its value.
   * @example
   * ```ts
   * const w = jupyter.widget({ esm: "export default {}", state: { count: 0 } });
   * w.fullState(); // { count: 0 }
   * ```
   */
  fullState(): WidgetState;
  /** Displaying a widget shows a view of it (application/vnd.jupyter.widget-view+json). */
  [$display](): MediaBundle;
}

export function removeBuffers(state: unknown): { state: unknown; bufferPaths: (string | number)[][]; buffers: Uint8Array[] };
export function putBuffers<T>(state: T, bufferPaths?: (string | number)[][], buffers?: Uint8Array[]): T;
export function createWidgetFactory(commApi: CommApi, $display: symbol): (options: WidgetOptions) => Widget;
