// @ts-self-types="./display.d.mts"
// The Jupyter display API that Deno exposes as `Deno.jupyter`, made
// runtime-neutral. Runs inside the target runtime (Node or Deno).
//
// Ported from Deno's cli/js/40_jupyter.js (v2.9.6), which is
// Copyright 2018-2026 the Deno authors, MIT license. The formatting rules
// (display symbol, canvas, Vega, JPEG/PNG bytes, HTML/SVG elements) are
// unchanged; Polars-style DataFrames show through table.mjs instead (#475),
// as do Arrow tables and DuckDB results. The Deno internals it used are
// injected:
//   Deno[Deno.internal].inspectArgs -> host.inspect
//   op_base64_encode_from_buffer    -> host.base64
//   Deno.readFileSync               -> host.readFile
//   op_jupyter_broadcast            -> host.send
// WebGPU texture/buffer display depends on Deno's wgpu bindings and is
// omitted. Comms, widgets, tables, SQL and charts (jupyter.comm,
// jupyter.widget, jupyter.table, jupyter.sql, jupyter.chart) are additions
// Deno doesn't have; see comm.mjs, widget.mjs, table.mjs, sql.mjs and
// chart.mjs.

import { createComms } from "./comm.mjs";
import { createHost } from "./host.mjs";
import { createWidgetFactory } from "./widget.mjs";
import { createSql } from "./sql.mjs";
import { createChart } from "./chart.mjs";
import { isTableLike, pageTable, tableBundle, tableSource } from "./table.mjs";
import { createTablePager } from "./table-paging.mjs";

export const $display = Symbol.for("Jupyter.display");

const rawToEntity = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#39;"],
]);
const rawRe = new RegExp(`[${[...rawToEntity.keys()].join("")}]`, "g");

export function escapeHTML(str) {
  return str.replaceAll(rawRe, (m) => rawToEntity.get(m) ?? m);
}

function isVegaLike(obj) {
  return obj !== null && typeof obj === "object" && "toSpec" in obj;
}

function extractVega(obj) {
  const spec = obj.toSpec();
  if (typeof spec !== "object" || spec === null || !("$schema" in spec)) return null;
  let mediaType = "application/vnd.vega.v5+json";
  if (spec.$schema === "https://vega.github.io/schema/vega-lite/v4.json") {
    mediaType = "application/vnd.vegalite.v4+json";
  } else if (spec.$schema === "https://vega.github.io/schema/vega-lite/v5.json") {
    mediaType = "application/vnd.vegalite.v5+json";
  }
  const summary = summarizeChart(spec);
  return summary === undefined ? { [mediaType]: spec } : { [mediaType]: spec, "text/plain": summary };
}

// A few lines of text/plain next to a chart, for frontends that can't draw
// it (jupyter console, nbconvert to text, agents reading the notebook):
// mark, encodings with value ranges, title and row count (#321). The
// approach follows nteract's repr-llm summarize_viz (BSD-3).
const VL_TYPES = { Q: "quantitative", N: "nominal", O: "ordinal", T: "temporal", G: "geojson" };
const MAX_CHILDREN = 6;

function clip(str, max = 60) {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function formatNumber(n) {
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(4)));
}

function titleText(title) {
  const text = typeof title === "object" && title !== null && !Array.isArray(title) ? title.text : title;
  const str = Array.isArray(text) ? text.join(" ") : typeof text === "string" ? text : "";
  return str ? ` "${clip(str, 80)}"` : "";
}

function getField(row, field) {
  if (row === null || typeof row !== "object") return undefined;
  if (field in row) return row[field];
  // Vega-Lite reads "a.b" as a nested path and "a\.b" as a key with a dot.
  if (field.includes("\\")) return row[field.replace(/\\(.)/g, "$1")];
  return field.split(".").reduce((obj, key) => (obj === null || typeof obj !== "object" ? undefined : obj[key]), row);
}

function fieldStats(rows, field, type) {
  const values = [];
  for (const row of rows) {
    const value = getField(row, field);
    if (value !== undefined && value !== null && value !== "") values.push(value);
  }
  if (values.length === 0) return "";
  if (type === "quantitative") {
    let min = Infinity;
    let max = -Infinity;
    for (const value of values) {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      if (n < min) min = n;
      if (n > max) max = n;
    }
    if (min > max) return "";
    return min === max ? formatNumber(min) : `${formatNumber(min)} to ${formatNumber(max)}`;
  }
  if (type === "temporal") {
    let min;
    let max;
    for (const value of values) {
      const t = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(String(value));
      if (!Number.isFinite(t)) continue;
      if (min === undefined || t < min.t) min = { t, value };
      if (max === undefined || t > max.t) max = { t, value };
    }
    if (min === undefined) return "";
    const show = ({ value }) =>
      typeof value === "string" ? clip(value, 30) : new Date(value instanceof Date ? value.getTime() : value).toISOString();
    return min.t === max.t ? show(min) : `${show(min)} to ${show(max)}`;
  }
  const distinct = new Set(values.map((value) => typeof value === "object" ? JSON.stringify(value) : String(value)));
  return `${distinct.size} ${distinct.size === 1 ? "value" : "values"}`;
}

function encodingSummary(encoding, rows) {
  const parts = [];
  for (const [channel, def] of Object.entries(encoding)) {
    if (channel === "tooltip" || def === null || typeof def !== "object" || Array.isArray(def)) continue;
    if (def.field === undefined && def.aggregate === undefined) continue;
    let name = typeof def.field === "string" ? def.field : def.field?.repeat ? `repeat ${def.field.repeat}` : "";
    if (def.aggregate !== undefined) name = `${def.aggregate}(${name})`;
    else if (def.timeUnit !== undefined) name = `${typeof def.timeUnit === "string" ? def.timeUnit : "time"}(${name})`;
    const type = VL_TYPES[def.type] ?? def.type;
    const details = [];
    if (typeof type === "string") details.push(type);
    if (rows && typeof def.field === "string" && def.aggregate === undefined) {
      const stats = fieldStats(rows, def.field, type);
      if (stats) details.push(stats);
    }
    parts.push(`${channel}=${clip(name, 40)}${details.length ? ` (${details.join(", ")})` : ""}`);
  }
  return parts;
}

function vlRows(data, datasets) {
  if (data === null || typeof data !== "object") return undefined;
  if (Array.isArray(data.values)) return data.values;
  if (typeof data.name === "string" && Array.isArray(datasets?.[data.name])) return datasets[data.name];
  return undefined;
}

function vlDataNote(data, rows) {
  if (rows) return `${rows.length} ${rows.length === 1 ? "row" : "rows"}`;
  if (typeof data?.url === "string") return `data from ${clip(data.url)}`;
  return "";
}

function fieldList(def) {
  if (Array.isArray(def)) return def.join(", ");
  if (def === null || typeof def !== "object") return "";
  if (typeof def.field === "string") return def.field;
  return Object.values(def).map(fieldList).filter(Boolean).join(", ");
}

function summarizeVegaLiteView(spec, label, inherited, datasets, depth, lines) {
  const indent = "  ".repeat(depth);
  const data = spec.data ?? inherited.data;
  const rows = vlRows(data, datasets);
  const head = `${indent}${label}`;
  const title = titleText(spec.title);
  const children = spec.layer ?? spec.concat ?? spec.hconcat ?? spec.vconcat;
  if (Array.isArray(children)) {
    const noun = spec.layer ? "layer" : "view";
    const note = [`${children.length} ${children.length === 1 ? noun : `${noun}s`}`, vlDataNote(data, rows)].filter(Boolean);
    lines.push(`${head}${spec.layer ? "layered" : "concatenated"} chart${title}: ${note.join(", ")}`);
    const encoding = spec.layer ? { ...inherited.encoding, ...spec.encoding } : {};
    children.slice(0, MAX_CHILDREN).forEach((child, i) => {
      if (child !== null && typeof child === "object") {
        summarizeVegaLiteView(child, `${noun} ${i + 1}: `, { data, encoding }, datasets, depth + 1, lines);
      }
    });
    if (children.length > MAX_CHILDREN) lines.push(`${indent}  … ${children.length - MAX_CHILDREN} more`);
    return;
  }
  if ((spec.facet !== undefined || spec.repeat !== undefined) && spec.spec !== null && typeof spec.spec === "object") {
    const what = spec.facet !== undefined ? `faceted by ${fieldList(spec.facet)}` : `repeated over ${fieldList(spec.repeat)}`;
    const note = vlDataNote(data, rows);
    lines.push(`${head}chart${title} ${what}${note ? `, ${note}` : ""}`);
    summarizeVegaLiteView(spec.spec, "each panel: ", { data, encoding: {} }, datasets, depth + 1, lines);
    return;
  }
  const mark = typeof spec.mark === "string" ? spec.mark : spec.mark?.type;
  const encoding = { ...inherited.encoding, ...spec.encoding };
  const parts = encodingSummary(encoding, rows);
  // A layer's rows were already counted on the layered chart's line.
  if (spec.data !== undefined || depth === 0) {
    const note = vlDataNote(data, rows);
    if (note) parts.push(note);
  }
  lines.push(`${head}${typeof mark === "string" ? `${mark} ` : ""}chart${title}${parts.length ? `: ${parts.join(", ")}` : ""}`);
}

function vegaMarkTypes(marks, types) {
  if (!Array.isArray(marks)) return types;
  for (const mark of marks) {
    if (typeof mark?.type === "string") types.add(mark.type);
    vegaMarkTypes(mark?.marks, types);
  }
  return types;
}

function summarizeVega(spec) {
  const sections = [];
  const marks = [...vegaMarkTypes(spec.marks, new Set())];
  if (marks.length) sections.push(`marks ${marks.join(", ")}`);
  const list = (items, describe) => {
    const shown = items.slice(0, MAX_CHILDREN).map(describe);
    if (items.length > MAX_CHILDREN) shown.push(`… ${items.length - MAX_CHILDREN} more`);
    return shown.join(", ");
  };
  const data = Array.isArray(spec.data) ? spec.data.filter((d) => d !== null && typeof d === "object") : [];
  if (data.length) {
    sections.push(`data ${list(data, (d) => {
      const name = clip(String(d.name ?? "?"), 30);
      if (Array.isArray(d.values)) return `${name} (${d.values.length} ${d.values.length === 1 ? "row" : "rows"})`;
      if (typeof d.url === "string") return `${name} (from ${clip(d.url)})`;
      if (d.source !== undefined) return `${name} (from ${clip(String(d.source), 30)})`;
      return name;
    })}`);
  }
  const scales = Array.isArray(spec.scales) ? spec.scales.filter((s) => s !== null && typeof s === "object") : [];
  if (scales.length) {
    sections.push(`scales ${list(scales, (s) => `${clip(String(s.name ?? "?"), 30)} (${s.type ?? "linear"})`)}`);
  }
  return `Vega chart${titleText(spec.title)}${sections.length ? `: ${sections.join("; ")}` : ""}`;
}

function summarizeChart(spec) {
  try {
    if (typeof spec.$schema === "string" && spec.$schema.includes("/vega-lite/")) {
      const lines = [];
      summarizeVegaLiteView(spec, "Vega-Lite ", { encoding: {} }, spec.datasets, 0, lines);
      return lines.join("\n");
    }
    return summarizeVega(spec);
  } catch {
    // A summary is a fallback; a spec it doesn't understand still renders.
    return undefined;
  }
}

function isCanvasLike(obj) {
  return obj !== null && typeof obj === "object" && "toDataURL" in obj;
}

export function isJpg(obj) {
  return obj instanceof Uint8Array && obj.length >= 4 &&
    obj[0] === 0xff && obj[1] === 0xd8 &&
    obj[obj.length - 2] === 0xff && obj[obj.length - 1] === 0xd9;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function isPng(obj) {
  return obj instanceof Uint8Array && obj.length >= PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((byte, i) => obj[i] === byte);
}

function isSVGElementLike(obj) {
  return obj !== null && typeof obj === "object" && typeof obj.outerHTML === "string" &&
    obj.outerHTML.startsWith("<svg");
}

function isHTMLElementLike(obj) {
  return obj !== null && typeof obj === "object" && typeof obj.outerHTML === "string";
}

function hasDisplaySymbol(obj) {
  return obj !== null && typeof obj === "object" && typeof obj[$display] === "function";
}

function isMediaBundle(obj) {
  return obj !== null && typeof obj === "object" && !Array.isArray(obj);
}

/**
 * @param {{
 *   inspect: (value: unknown) => string,
 *   base64: (bytes: Uint8Array) => string,
 *   readFile: (path: string) => Uint8Array,
 *   send: (msgType: string, content: object, metadata: object, buffers: Uint8Array[]) => void,
 *   input: (prompt: string, password: boolean) => string | null,
 *   params?: () => string | undefined,
 * }} host
 */
/** The MIME type of a named result (cdp-kernel#456): `{ name, value }`. */
export const RESULT_MIME = "application/vnd.ganymede.result+json";

function deepFreeze(value) {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export function createJupyter(host) {
  async function format(obj) {
    return await formatNow(obj);
  }

  // format without awaiting: the debugger's variable viewer formats values
  // while the target is paused, when no promise settles (#18). A $display
  // method's promise is the caller's to handle.
  function formatNow(obj) {
    if (hasDisplaySymbol(obj)) return obj[$display]();
    if (typeof obj !== "object" || obj === null) return { "text/plain": host.inspect(obj) };
    if (isCanvasLike(obj)) {
      const [prefix, data] = obj.toDataURL().split(",");
      return { [prefix.split(":")[1].split(";")[0]]: data };
    }
    if (isVegaLike(obj)) {
      const vega = extractVega(obj);
      if (vega) return vega;
    }
    // Arrow tables, Polars DataFrames and DuckDB results (#475).
    if (isTableLike(obj)) return tableBundle(tableSource(obj));
    if (isJpg(obj)) return { "image/jpeg": host.base64(obj) };
    if (isPng(obj)) return { "image/png": host.base64(obj) };
    if (isSVGElementLike(obj)) return { "image/svg+xml": obj.outerHTML };
    if (isHTMLElementLike(obj)) return { "text/html": obj.outerHTML };
    return { "text/plain": host.inspect(obj) };
  }

  function taggedTemplate(mediatype) {
    return (strings, ...values) => {
      const payload = strings.reduce((acc, string, i) =>
        acc + string + (values[i] !== undefined ? values[i] : ""), "");
      return { [$display]: () => ({ [mediatype]: payload }) };
    };
  }

  function image(obj) {
    if (typeof obj === "string") {
      // As Deno does: a path that can't be read gets the TypeError below.
      try {
        obj = host.readFile(obj);
      } catch {
        // fall through
      }
    }
    if (isJpg(obj)) return { [$display]: () => ({ "image/jpeg": host.base64(obj) }) };
    if (isPng(obj)) return { [$display]: () => ({ "image/png": host.base64(obj) }) };
    throw new TypeError(
      "Object is not a valid image or a path to an image. `jupyter.image` supports displaying JPG or PNG images.",
    );
  }

  // jupyter.table (#475): rows and columns as Ganymede's table output,
  // built now so a bad value fails the call, not the display.
  function table(value, options = {}) {
    const bundle = tableBundle(tableSource(value, options), options);
    return { [$display]: () => bundle };
  }

  function broadcast(msgType, content, { metadata = {}, buffers = [] } = {}) {
    host.send(msgType, content, metadata, buffers);
  }

  // Set below, once the comms are: a table cut by the cap is kept for
  // paging when it is sent as an output, not when it is formatted.
  let pager;

  async function display(obj, options = { raw: false, update: false }) {
    const bundle = options.raw && isMediaBundle(obj) ? obj : await format(obj);
    broadcast(options.update ? "update_display_data" : "display_data", {
      data: pageTable(bundle, pager, options.display_id),
      metadata: {},
      transient: options.display_id ? { display_id: options.display_id } : {},
    });
  }

  async function broadcastResult(executionCount, result) {
    if (result === undefined) return;
    try {
      broadcast("execute_result", {
        execution_count: executionCount,
        data: pageTable(await format(result), pager),
        metadata: {},
        // nbclient crashes on a null `transient`; Deno learned this too.
        transient: {},
      });
    } catch (err) {
      broadcast("error", {
        ename: err instanceof Error ? err.name : "Error",
        evalue: err instanceof Error ? err.message : String(err),
        traceback: err instanceof Error && err.stack ? err.stack.split("\n") : [],
      });
    }
  }

  function confirm(message = "Confirm") {
    const answer = host.input(`${message} [y/N] `, false);
    return answer === "Y" || answer === "y";
  }

  function prompt(message = "Prompt", defaultValue = "", { password = false } = {}) {
    if (defaultValue != "") message += ` [${defaultValue}]`;
    const answer = host.input(message, password);
    return answer === "" ? defaultValue : answer;
  }

  // jupyter.params (cdp-kernel#456): the run's parameters, which the host
  // (ganymede execute -p) passes as JSON in GANYMEDE_PARAMS. Parsed on first
  // read, so a bad value fails the cell that reads it, not the kernel.
  let params;
  function readParams() {
    if (params !== undefined) return params;
    const text = host.params?.();
    if (text === undefined || text === "") return (params = Object.freeze({}));
    let value;
    try {
      value = JSON.parse(text);
    } catch (err) {
      throw new TypeError(`GANYMEDE_PARAMS is not JSON: ${err instanceof Error ? err.message : err}`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("GANYMEDE_PARAMS must be a JSON object, such as {\"counter\": \"Fremont\"}");
    }
    return (params = deepFreeze(value));
  }

  // jupyter.result (cdp-kernel#456): a named value as an output of
  // Ganymede's result type, which a run's caller reads without parsing
  // outputs. JSON only, so every reader sees the same value.
  function result(name, value) {
    if (typeof name !== "string" || name === "") throw new TypeError("jupyter.result: name must be a non-empty string");
    let text;
    try {
      text = JSON.stringify(value);
    } catch (err) {
      throw new TypeError(`jupyter.result: ${name} is not JSON: ${err instanceof Error ? err.message : err}`);
    }
    if (text === undefined) throw new TypeError(`jupyter.result: ${name} is not JSON (${typeof value})`);
    const json = JSON.parse(text);
    broadcast("display_data", {
      data: { [RESULT_MIME]: { name, value: json }, "text/plain": `${name} = ${text}` },
      metadata: {},
      transient: {},
    });
  }

  // The cell's own import, so npm: resolution and the browser target's CDN
  // apply to the packages jupyter.sql and jupyter.chart load.
  const cellImport = (what) => (specifier) => {
    const load = globalThis.__cdpk?.import;
    if (typeof load !== "function") return Promise.reject(new Error(`${what}: no module loader in this runtime`));
    return load(specifier);
  };

  // jupyter.sql (#477): DuckDB, loaded on the first query; an interrupt
  // (jupyter.signal) interrupts the query.
  const sql = createSql({
    importModule: cellImport("jupyter.sql"),
    mapped: (specifier) => globalThis.__cdpk?.mapped?.(specifier) ?? null,
    signal: () => current.signal,
  });

  // jupyter.chart (#479): vega, vega-lite or linkedom, loaded on first use.
  const chart = createChart({ importModule: cellImport("jupyter.chart"), summarizeSpec: summarizeChart });

  const comms = createComms((msgType, content, metadata, buffers) => host.send(msgType, content, metadata, buffers));
  // Tables cut by the cap page through the kernel over a comm (ganymede#747).
  pager = createTablePager(comms.api);

  // jupyter.signal (#418): aborted when the kernel is interrupted, so cell
  // code can stop waiting on what the interrupt can't reach, such as a comm
  // reply. Each cell gets its own, as does a comm handler that starts while
  // no cell runs; a handler during a cell shares the cell's. An interrupt
  // aborts only those of the cell and handlers running (#421).
  /** The last cell's controller. */
  let cell = new AbortController();
  /** What jupyter.signal returns: that of whatever started last. */
  let current = cell;
  /** Controllers of running comm handlers, with how many handlers use each. */
  const handlers = new Map();
  function startCell() {
    current = cell = new AbortController();
  }
  /** `cellRunning`: the host has a cell in flight, so the last cell's signal is aborted too. */
  function abortSignal(cellRunning = true) {
    const reason = new DOMException("Execution interrupted", "AbortError");
    if (cellRunning) cell.abort(reason);
    for (const controller of handlers.keys()) controller.abort(reason);
    handlers.clear();
  }
  // jupyter.host() (#461): Ganymede's host API. Registers its comm target
  // now, so the comm the server opens at kernel start finds it. A call
  // without a signal watches the jupyter.signal of whatever started it.
  const hostApi = createHost(comms.api, () => current.signal);

  async function commDispatch(msgType, content, metadata, buffers, ownSignal = false) {
    // A handler during a cell shares the cell's signal, and is tracked
    // apart from it: it can outlive the cell.
    const controller = ownSignal ? new AbortController() : cell;
    if (ownSignal) current = controller;
    handlers.set(controller, (handlers.get(controller) ?? 0) + 1);
    try {
      return await comms.dispatch(msgType, content, metadata, buffers);
    } finally {
      const left = (handlers.get(controller) ?? 0) - 1;
      if (left > 0) handlers.set(controller, left);
      else handlers.delete(controller);
    }
  }

  return {
    namespace: {
      get signal() {
        return current.signal;
      },
      broadcast,
      display,
      get params() {
        return readParams();
      },
      result,
      table,
      sql,
      chart,
      format,
      md: taggedTemplate("text/markdown"),
      html: taggedTemplate("text/html"),
      svg: taggedTemplate("image/svg+xml"),
      image,
      $display,
      comm: comms.api,
      host: hostApi.host,
      widget: createWidgetFactory(comms.api, $display),
    },
    broadcastResult,
    formatNow,
    confirm,
    prompt,
    commDispatch,
    startCell,
    abortSignal,
  };
}
