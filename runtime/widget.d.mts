import type { CommApi } from "./comm.d.mts";
import type { $display, MediaBundle } from "./display.d.mts";

export const WIDGET_PROTOCOL_VERSION: "2.1.0";

export type WidgetState = { [key: string]: unknown };

/** Options for `jupyter.widget`. */
export interface WidgetOptions {
  /**
   * The [anywidget](https://anywidget.dev) view module, as source:
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
 * An [anywidget](https://anywidget.dev) model, from `jupyter.widget`, synced with its frontend
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
   * @example
   * ```ts
   * const progress = jupyter.widget({
   *   esm: `export default {
   *     render({ model, el }) {
   *       el.innerHTML =
   *         '<div class="progress-track"><div class="progress-fill"></div></div>' +
   *         '<div class="progress-label"></div>';
   *       const fill = el.querySelector(".progress-fill");
   *       const label = el.querySelector(".progress-label");
   *       const update = () => {
   *         const percent = Math.round(model.get("value") * 100);
   *         fill.style.width = percent + "%";
   *         label.textContent = model.get("message") + " (" + percent + "%)";
   *       };
   *       model.on("change:value", update);
   *       model.on("change:message", update);
   *       update();
   *     },
   *   };`,
   *   css: `
   *     .progress-track { width: 320px; height: 10px; border-radius: 5px; background: #e5e7eb; overflow: hidden; }
   *     .progress-fill { height: 100%; background: #2e6e64; transition: width 0.2s; }
   *     .progress-label { margin-top: 6px; font: 13px system-ui, sans-serif; color: #444; }
   *   `,
   *   state: { value: 0, message: "Starting" },
   * });
   * await jupyter.display(progress);
   *
   * const files = ["january.csv", "february.csv", "march.csv", "april.csv", "may.csv"];
   * for (const [i, file] of files.entries()) {
   *   progress.set({ message: "Processing " + file, value: i / files.length });
   *   await new Promise((resolve) => setTimeout(resolve, 600)); // stand-in for real work
   * }
   * progress.set({ message: "Done", value: 1 });
   * ```
   * ![A progress bar three fifths full, labelled "Processing april.csv (60%)", captured while the cell was still running.](https://cdp-kernel.org/images/widgets/progress.png)
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
   * @example
   * ```ts
   * const temperature = jupyter.widget({
   *   esm: `export default {
   *     render({ model, el }) {
   *       const slider = document.createElement("input");
   *       slider.type = "range";
   *       slider.min = "-20";
   *       slider.max = "40";
   *       const label = document.createElement("span");
   *       const update = () => {
   *         slider.value = String(model.get("celsius"));
   *         label.textContent = " " + model.get("celsius") + " °C is " + model.get("fahrenheit") + " °F";
   *       };
   *       slider.oninput = () => {
   *         model.set("celsius", slider.valueAsNumber);
   *         model.save_changes();
   *       };
   *       model.on("change:celsius", update);
   *       model.on("change:fahrenheit", update);
   *       update();
   *       el.append(slider, label);
   *     },
   *   };`,
   *   state: { celsius: 20, fahrenheit: 68 },
   * });
   *
   * temperature.on("change:celsius", (celsius) => {
   *   temperature.set("fahrenheit", Math.round((Number(celsius) * 9) / 5 + 32));
   * });
   *
   * temperature;
   * ```
   * ![A range slider moved to 30, labelled "30 °C is 86 °F".](https://cdp-kernel.org/images/widgets/temperature.png)
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
   * @example
   * ```ts
   * const dice = jupyter.widget({
   *   esm: `export default {
   *     render({ model, el }) {
   *       const button = document.createElement("button");
   *       button.textContent = "Roll 3 dice";
   *       button.onclick = () => model.send({ count: 3 });
   *       const result = document.createElement("span");
   *       result.style.marginLeft = "12px";
   *       result.style.fontSize = "24px";
   *       model.on("msg:custom", (message) => {
   *         result.textContent = message.faces + "  (total " + message.total + ")";
   *       });
   *       el.append(button, result);
   *     },
   *   };`,
   * });
   *
   * dice.on("msg:custom", (content) => {
   *   const { count } = content as { count: number };
   *   const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * 6));
   *   dice.send({
   *     faces: rolls.map((n) => "⚀⚁⚂⚃⚄⚅"[n - 1]).join(" "),
   *     total: rolls.reduce((a, b) => a + b, 0),
   *   });
   * });
   *
   * dice;
   * ```
   * ![A "Roll 3 dice" button next to three die faces and their total, the kernel's answer to a click.](https://cdp-kernel.org/images/widgets/dice.png)
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
   * The full state, as the frontend sees it: [anywidget](https://anywidget.dev)'s model keys
   * (`_model_name`, `_view_name` and the rest) and the widget's own.
   *
   * @returns Every state key and its value.
   * @example
   * ```ts
   * const w = jupyter.widget({ esm: "export default {}", state: { count: 0 } });
   * w.fullState(); // { _model_name: "AnyModel", _model_module: "anywidget", ..., count: 0 }
   * ```
   */
  fullState(): WidgetState;
  /** Displaying a widget shows a view of it (application/vnd.jupyter.widget-view+json). */
  [$display](): MediaBundle;
}

export function removeBuffers(state: unknown): { state: unknown; bufferPaths: (string | number)[][]; buffers: Uint8Array[] };
export function putBuffers<T>(state: T, bufferPaths?: (string | number)[][], buffers?: Uint8Array[]): T;
export function createWidgetFactory(commApi: CommApi, $display: symbol): (options: WidgetOptions) => Widget;
