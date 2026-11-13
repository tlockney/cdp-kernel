import type { CommApi, Comms } from "./comm.d.mts";
import type { Host, HostCallOptions, HostError, HostErrorCode, HostNotebooks, HostOptions, HostSelf, NotebookEntry, NotebookHit, NotebookSearch } from "./host.d.mts";
import type { Widget, WidgetOptions } from "./widget.d.mts";
import type { Sql, SqlColumn, SqlFragment, SqlResult } from "./sql.d.mts";

export type { Sql, SqlColumn, SqlFragment, SqlResult };
export type { CommApi, Host, HostCallOptions, HostError, HostErrorCode, HostNotebooks, HostOptions, HostSelf, NotebookEntry, NotebookHit, NotebookSearch, Widget, WidgetOptions };

/**
 * The symbol a class implements to choose how its instances appear. At
 * runtime it is `Symbol.for("Jupyter.display")`, so a library can use that
 * form without the `jupyter` global.
 */
export const $display: unique symbol;

/**
 * A Jupyter MIME bundle: media type to content, such as
 * `{ "text/plain": "42", "text/html": "<b>42</b>" }`. Binary images are
 * base64 strings; JSON types (`application/json`, Vega-Lite) are objects.
 */
export type MediaBundle = { [mediaType: string]: unknown };

export interface DisplayHost {
  inspect: (value: unknown) => string;
  base64: (bytes: Uint8Array) => string;
  readFile: (path: string) => Uint8Array;
  send: (msgType: string, content: object, metadata: object, buffers: Uint8Array[]) => void;
  input: (prompt: string, password: boolean) => string | null;
  /** The run's parameters as JSON text, or `undefined` when there are none. */
  params?: () => string | undefined;
}

/** The MIME type of a named result: `{ name, value }`. */
export const RESULT_MIME: "application/vnd.ganymede.result+json";

/** A JSON value, as `JSON.parse` returns it. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Options for `jupyter.table`. */
export interface TableOptions {
  /** Rows to embed: default 1,000, at most 10,000, and never past 1 MB of JSON. */
  limit?: number;
  /** The columns to show, in order. Names an array of arrays' columns. */
  columns?: string[];
  /** A caption for the table. */
  title?: string;
}

/** Options for `jupyter.chart` with a Vega-Lite or Vega spec. */
export interface ChartOptions {
  /**
   * Also keep the spec under its Vega MIME type, for a frontend that
   * draws Vega itself. Default `false`: the SVG and a text summary only.
   */
  spec?: boolean;
}

/** Options for `jupyter.display`. */
export interface DisplayOptions {
  /**
   * Send a plain object as the MIME bundle itself instead of formatting
   * it. Default `false`.
   */
  raw?: boolean;
  /**
   * Replace every earlier output that has the same `display_id`, including
   * one shown by an earlier cell, instead of adding an output. Needs
   * `display_id`. Default `false`.
   */
  update?: boolean;
  /** An id that a later display with `update: true` can replace. */
  display_id?: string;
}

/** A value that renders as rich output: it has a `[jupyter.$display]` method. */
export interface Displayable {
  /** Returns the value's MIME bundle, or a promise of one. */
  [$display]: () => MediaBundle | Promise<MediaBundle>;
}

/**
 * The `jupyter` global: how values appear in the notebook. The same object
 * as `Deno.jupyter` in `deno jupyter`.
 */
export interface JupyterNamespace {
  /**
   * Send a raw Jupyter message on the kernel's output channel (IOPub), as a
   * reply to the running cell. The other helpers are built on it. It does
   * not check the message: a wrong field is ignored or mishandled by the
   * frontend.
   *
   * @param msgType An IOPub message type, such as `"clear_output"` or
   *   `"display_data"`.
   * @param content The message content, as the messaging spec defines it
   *   for `msgType`.
   * @param options `metadata` for the message, and binary `buffers`.
   * @example
   * ```ts
   * // Count down in place: clear_output with wait avoids a flicker.
   * for (const n of [3, 2, 1]) {
   *   jupyter.broadcast("clear_output", { wait: true });
   *   await jupyter.display(jupyter.md`Launching in **${n}**…`);
   *   await new Promise((resolve) => setTimeout(resolve, 1000));
   * }
   * ```
   * @see jupyter-api.md#raw-messages-with-broadcast
   */
  broadcast(
    msgType: string,
    content: object,
    options?: { metadata?: object; buffers?: Uint8Array[] },
  ): void;
  /**
   * Show a value now, in the middle of a cell, or replace one shown
   * earlier. The value can be anything a cell could end with: a template
   * from `md`, `html` or `svg`, an image, a widget, an object with a
   * `[jupyter.$display]` method, or a plain value, shown as text.
   *
   * @param obj The value to show.
   * @param options `display_id` and `update` to replace an earlier output;
   *   `raw` to send a plain object as the MIME bundle itself.
   * @returns Resolves once the output is sent. Without `await` the output
   *   still appears, but later output in the cell can appear before it.
   * @example
   * ```ts
   * const bar = (pct: number) => jupyter.html`<progress value="${pct}" max="100"></progress>`;
   * await jupyter.display(bar(0), { display_id: "download" });
   * for (let pct = 25; pct <= 100; pct += 25) {
   *   await new Promise((resolve) => setTimeout(resolve, 500));
   *   await jupyter.display(bar(pct), { display_id: "download", update: true });
   * }
   * ```
   * @example
   * ```ts
   * // A MIME bundle sent as is: JupyterLab renders it as a JSON tree.
   * const user = { name: "Ada", active: true };
   * await jupyter.display(
   *   { "application/json": user, "text/plain": JSON.stringify(user) },
   *   { raw: true },
   * );
   * ```
   * @see jupyter-api.md#showing-output-with-display
   */
  display(obj: unknown, options?: DisplayOptions): Promise<void>;
  /**
   * The MIME bundle that displaying a value would send, without showing
   * anything. For plain values `text/plain` holds terminal color codes,
   * as the notebook shows them.
   *
   * @param obj The value to format.
   * @returns The bundle, for example `{ "text/plain": "\x1b[33m42\x1b[39m" }`
   *   for `42`.
   * @example
   * ```ts
   * const bundle = await jupyter.format(jupyter.md`# Weekly report`);
   * bundle["text/markdown"]; // "# Weekly report"
   * ```
   * @see jupyter-api.md#getting-a-bundle-with-format
   */
  format(obj: unknown): Promise<MediaBundle>;
  /**
   * A tagged template that renders as Markdown. Interpolated values are
   * inserted as is, without escaping.
   *
   * @returns A value that shows as `text/markdown` as a cell's result or
   *   through `display`.
   * @example
   * ```ts
   * const scores = { Ada: 92, Grace: 88 };
   * const rows = Object.entries(scores).map(([n, s]) => `| ${n} | ${s} |`).join("\n");
   * jupyter.md`| Name | Score |
   * | --- | --- |
   * ${rows}`;
   * ```
   * @see jupyter-api.md#markdown
   */
  md(strings: TemplateStringsArray, ...values: unknown[]): Displayable;
  /**
   * A tagged template that renders as HTML. Interpolated values are
   * inserted as is, without escaping: escape text from users, files or
   * the network yourself.
   *
   * @returns A value that shows as `text/html`.
   * @example
   * ```ts
   * const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
   * const comment = "<script>alert(1)</script>";
   * jupyter.html`<p>${escape(comment)}</p>`;
   * ```
   * @see jupyter-api.md#html
   */
  html(strings: TemplateStringsArray, ...values: unknown[]): Displayable;
  /**
   * A tagged template that renders as SVG. Include the `xmlns` attribute.
   * Interpolated values are inserted as is, without escaping.
   *
   * @returns A value that shows as `image/svg+xml`.
   * @example
   * ```ts
   * const data = [4, 8, 15, 16];
   * const bars = data.map((v, i) => `<rect x="${i * 20}" y="${40 - v * 2}" width="16" height="${v * 2}"/>`).join("");
   * jupyter.svg`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40">${bars}</svg>`;
   * ```
   * @see jupyter-api.md#svg
   */
  svg(strings: TemplateStringsArray, ...values: unknown[]): Displayable;
  /**
   * Show a PNG or JPEG. The format is read from the bytes, not the file
   * name.
   *
   * @param obj A file path, relative to the notebook's directory, or the
   *   image's bytes.
   * @returns A value that shows as `image/png` or `image/jpeg`.
   * @throws {TypeError} The bytes are not PNG or JPEG, or the path can't
   *   be read.
   * @availability Paths need a file system: on workerd and celld pass
   *   bytes.
   * @example
   * ```ts
   * jupyter.image("./chart.png");
   * ```
   * @example
   * ```ts
   * const response = await fetch("https://www.python.org/static/img/python-logo.png");
   * jupyter.image(new Uint8Array(await response.arrayBuffer()));
   * ```
   * @see jupyter-api.md#images
   */
  image(obj: string | Uint8Array): Displayable;
  /**
   * The symbol a class implements to choose how its instances appear. The
   * method returns a MIME bundle, or a promise of one. It is used for a
   * cell's result, `display` and `format`, but not for objects nested in
   * other values. At runtime it is `Symbol.for("Jupyter.display")`.
   *
   * @example
   * ```ts
   * class Temperature {
   *   celsius: number;
   *   constructor(celsius: number) {
   *     this.celsius = celsius;
   *   }
   *   [jupyter.$display]() {
   *     return { "text/plain": `${this.celsius}°C`, "text/html": `<b>${this.celsius}°C</b>` };
   *   }
   * }
   * new Temperature(21);
   * ```
   * @see jupyter-api.md#custom-display-for-your-own-classes
   */
  $display: typeof $display;
  /**
   * Jupyter comms: message channels to the frontend outside cell
   * execution. Its methods are in the widgets and comms reference.
   *
   * @see widgets.md#comms
   */
  comm: CommApi;
  /**
   * Create an anywidget-compatible widget model. Display it (or end the
   * cell with it) to show a view.
   *
   * @param options The view module, its CSS, and the initial state.
   * @returns The model, synced with every view of it.
   * @throws {TypeError} `options.esm` is not a string.
   * @availability The frontend needs the anywidget extension.
   * @example
   * ```ts
   * const counter = jupyter.widget({
   *   esm: `export default {
   *     render({ model, el }) {
   *       const button = document.createElement("button");
   *       const update = () => {
   *         button.textContent = "count is " + model.get("count");
   *       };
   *       button.onclick = () => {
   *         model.set("count", model.get("count") + 1);
   *         model.save_changes();
   *       };
   *       model.on("change:count", update);
   *       update();
   *       el.append(button);
   *     },
   *   };`,
   *   state: { count: 0 },
   * });
   * counter; // the cell's result: displays the widget
   * ```
   * ![A JupyterLab cell that creates a counter widget with jupyter.widget. Below the code, the output is a button reading "count is 3" after three clicks.](https://cdp-kernel.org/images/widgets/counter.png)
   * @see widgets.md#a-first-widget-a-counter
   */
  widget(options: WidgetOptions): Widget;
  /**
   * An `AbortSignal` that an interrupt aborts, so code waiting on something
   * only it can end can stop and clean up. Each cell gets its own, as does
   * a comm handler that starts while no cell runs. Read it once when the
   * work starts: a later read gets the signal of whatever started last.
   * The abort reason is a `DOMException` named `AbortError`.
   *
   * @example
   * ```ts
   * const response = await fetch("https://example.com/large.csv", { signal: jupyter.signal });
   * ```
   * @example
   * ```ts
   * const signal = jupyter.signal;
   * const ask = jupyter.comm.open("my.app", { question: "ready?" });
   * const answer = await new Promise((resolve, reject) => {
   *   ask.onMsg((m) => resolve(m.data));
   *   signal.addEventListener("abort", () => { ask.close(); reject(signal.reason); }, { once: true });
   * });
   * ```
   * @see jupyter-api.md#stopping-on-interrupt-jupyter-signal
   */
  readonly signal: AbortSignal;
  /**
   * The parameters of this run: a frozen object, empty unless whoever
   * started the kernel passed some, such as `ganymede execute -p
   * counter="2nd Ave"`. They arrive as a JSON object in the kernel's
   * `GANYMEDE_PARAMS` environment variable. Take defaults with
   * destructuring, so the notebook also runs on its own.
   *
   * @throws {TypeError} `GANYMEDE_PARAMS` is set but isn't a JSON object.
   * @availability Node, Deno, Bun, workerd and celld read the kernel's
   *   environment; the browser target takes `params` from its options.
   * @example
   * ```ts
   * const { counter = "Fremont", days = 30 } = jupyter.params as { counter?: string; days?: number };
   * `${counter}, last ${days} days`;
   * ```
   * @see jupyter-api.md#parameters-and-named-results
   */
  readonly params: { readonly [name: string]: JsonValue };
  /**
   * Publish a value under a name, as an output that a run's caller reads
   * by name instead of parsing outputs: `ganymede execute --results`, or
   * another notebook. The output has the MIME type
   * `application/vnd.ganymede.result+json` holding `{ name, value }`, and
   * a `text/plain` line `name = value` for frontends that don't know the
   * type. When a name is published twice, readers take the last one.
   *
   * @param name The result's name.
   * @param value Any value `JSON.stringify` accepts; it is stored as JSON,
   *   so a `Date` becomes its ISO string.
   * @throws {TypeError} `name` is empty, or `value` isn't JSON (a
   *   function, `undefined`, a `BigInt` or a cycle).
   * @example
   * ```ts
   * const counts = [3120, 2890, 2410];
   * jupyter.result("weekday_drop", (counts[2] - counts[0]) / counts[0]);
   * jupyter.result("counts", counts);
   * ```
   * @see jupyter-api.md#parameters-and-named-results
   */
  result(name: string, value: unknown): void;
  /**
   * Show rows and columns as a table. The output has Ganymede's table
   * type, `application/vnd.dataresource+json` (Table Schema fields, up to
   * `limit` rows as JSON, and the total row count), which the Ganymede
   * apps show with sorting and paging; a plain HTML table of the first
   * and last rows for JupyterLab and VS Code; and a text summary of each
   * column's type and range for agents and consoles.
   *
   * An Arrow table, a Polars DataFrame or a DuckDB result also shows this
   * way when it is a cell's value; pass one here to set `limit`,
   * `columns` or `title`.
   *
   * @param value An array of row objects, an array of arrays (name them
   *   with `columns`), an Arrow table (apache-arrow, duckdb-wasm), a
   *   Polars DataFrame, or a `@duckdb/node-api` result.
   * @param options `limit`: rows to embed, default 1,000, at most 10,000,
   *   and never more than 1 MB of JSON. `columns`: which columns, in order.
   *   `title`: a caption.
   * @throws {TypeError} `value` isn't one of those, or `limit` isn't a
   *   whole number.
   * @example
   * ```ts
   * const moons = [
   *   { moon: "Io", radius_km: 1821.6, discovered: new Date("1610-01-08") },
   *   { moon: "Europa", radius_km: 1560.8, discovered: new Date("1610-01-08") },
   *   { moon: "Ganymede", radius_km: 2634.1, discovered: new Date("1610-01-07") },
   * ];
   * jupyter.table(moons, { title: "Galilean moons" });
   * ```
   * @see jupyter-api.md#tables
   */
  table(value: unknown, options?: TableOptions): Displayable;
  /**
   * Run SQL on an in-memory [DuckDB](https://duckdb.org) database, as a
   * tagged template: each `${value}` becomes a bound parameter, never
   * query text, so values can't change the query. Resolves to a
   * `SqlResult`, which shows as a table and has `columns` and `rows`.
   *
   * The database opens on the first query and lasts until the kernel
   * restarts or `jupyter.sql.close()`. DuckDB reads CSV, Parquet and JSON
   * files by path or URL; `jupyter.sql.load` makes a table from rows the
   * notebook already has. An interrupt stops a running query.
   *
   * @throws {TypeError} Called as a function rather than a tag.
   * @availability Node, Deno and Bun use `@duckdb/node-api`; the browser
   *   target (the Ganymede apps) uses duckdb-wasm from a CDN. Not on
   *   workerd or celld.
   * @example
   * ```ts
   * const min = 2000;
   * await jupyter.sql`
   *   select moon, radius_km
   *   from (values ('Io', 1821.6), ('Ganymede', 2634.1), ('Callisto', 2410.3)) as m(moon, radius_km)
   *   where radius_km > ${min}
   *   order by radius_km desc`;
   * ```
   * @see jupyter-api.md#sql-with-duckdb
   */
  readonly sql: Sql;
  /**
   * Draw a chart in the kernel as one SVG, with its title and legend
   * inside, plus a text summary for readers that can't see it. The SVG
   * shows the same in the Ganymede apps, JupyterLab, VS Code and a
   * published page. Text and axes take the reader's text color.
   *
   * Pass a [Vega-Lite](https://vega.github.io/vega-lite/) or Vega spec
   * (or a vega-lite-api chart), or the
   * [Observable Plot](https://observablehq.com/plot/) module and the
   * options you would give `Plot.plot`. Plot's `title`, `subtitle`,
   * `caption` and a `color: { legend: true }` legend are drawn into the
   * SVG. An SVG element shows as it is.
   *
   * vega and vega-lite (version 6), and linkedom for Plot where there is
   * no DOM, load through the cell's import on first use. A chart past
   * 2 MB of SVG logs a warning: aggregate or sample first.
   *
   * @param chart A Vega-Lite or Vega spec, the Plot module, or an SVG
   *   element.
   * @param options With a spec, `ChartOptions`; with Plot, Plot's options.
   * @throws {TypeError} `chart` is none of those, or Plot comes without
   *   options.
   * @example
   * ```ts
   * jupyter.chart({
   *   title: "Galilean moons",
   *   data: { values: [
   *     { moon: "Io", radius_km: 1821.6 },
   *     { moon: "Europa", radius_km: 1560.8 },
   *     { moon: "Ganymede", radius_km: 2634.1 },
   *     { moon: "Callisto", radius_km: 2410.3 },
   *   ] },
   *   mark: "bar",
   *   encoding: {
   *     x: { field: "moon", sort: "-y" },
   *     y: { field: "radius_km", type: "quantitative" },
   *   },
   * });
   * ```
   * @see jupyter-api.md#charts
   */
  chart(chart: object, options?: ChartOptions | Record<string, unknown>): Displayable;
  /**
   * The Ganymede server running this kernel, through its host API: read,
   * search and (when granted) run other notebooks under its root. The
   * server opens a comm to the kernel when it starts; this resolves to
   * `null` when none answers, as under plain Jupyter.
   *
   * Each call returns a promise and takes `{ signal }`, by default
   * `jupyter.signal`, so an interrupt cancels it. A failed call rejects
   * with a `HostError` whose `code` says why: `denied` for a notebook or
   * method this notebook isn't granted. Branch on `code`: `HostError`
   * isn't a global, so `instanceof` isn't available.
   *
   * @param options `timeout`: how long to wait for a server, in ms.
   * @throws {HostError} `cancelled` when an interrupt ends the wait.
   * @example
   * ```ts
   * const host = await jupyter.host();
   * if (host) {
   *   const { hits } = await host.notebooks.search({ query: "weekday drop", dir: "journal" });
   *   hits.map((h) => `${h.path}: ${h.excerpt}`);
   * }
   * ```
   * @see jupyter-api.md#other-notebooks-jupyter-host
   */
  host(options?: HostOptions): Promise<Host | null>;
}

export interface Jupyter {
  namespace: JupyterNamespace;
  broadcastResult(executionCount: number, result: unknown): Promise<void>;
  /** format without awaiting; a $display method's promise is returned as is. */
  formatNow(obj: unknown): unknown;
  confirm(message?: string): boolean;
  prompt(message?: string, defaultValue?: string, options?: { password?: boolean }): string | null;
  /**
   * Routes a frontend comm message into the kernel's comms. `ownSignal`
   * (no cell is running) gives its handlers their own jupyter.signal.
   */
  commDispatch(
    msgType: string,
    content: { [key: string]: unknown },
    metadata: { [key: string]: unknown },
    buffers: Uint8Array[],
    ownSignal?: boolean,
  ): Promise<boolean>;
  /** A new jupyter.signal: a cell is starting (#421). */
  startCell(): void;
  /**
   * Aborts the running comm handlers' jupyter.signal, and the last cell's
   * unless `cellRunning` is false: the kernel was interrupted.
   */
  abortSignal(cellRunning?: boolean): void;
}

export function escapeHTML(str: string): string;
export function isJpg(obj: unknown): boolean;
export function isPng(obj: unknown): boolean;
export function createJupyter(host: DisplayHost): Jupyter;
