// @ts-self-types="./display.d.mts"
// The Jupyter display API that Deno exposes as `Deno.jupyter`, made
// runtime-neutral. Runs inside the target runtime (Node or Deno).
//
// Ported from Deno's cli/js/40_jupyter.js (v2.9.6), which is
// Copyright 2018-2026 the Deno authors, MIT license. The formatting rules
// (display symbol, canvas, Vega, Polars-style DataFrames, JPEG/PNG bytes,
// HTML/SVG elements) are unchanged; the Deno internals it used are injected:
//   Deno[Deno.internal].inspectArgs -> host.inspect
//   op_base64_encode_from_buffer    -> host.base64
//   Deno.readFileSync               -> host.readFile
//   op_jupyter_broadcast            -> host.send
// WebGPU texture/buffer display depends on Deno's wgpu bindings and is
// omitted. Comms and widgets (jupyter.comm, jupyter.widget) are additions
// Deno doesn't have; see comm.mjs and widget.mjs.

import { createComms } from "./comm.mjs";
import { createWidgetFactory } from "./widget.mjs";

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

function isDataFrameLike(obj) {
  return obj !== null && typeof obj === "object" &&
    obj.schema !== undefined && typeof obj.schema === "object" &&
    typeof obj.head === "function" && typeof obj.toRecords === "function";
}

function mapPolarsTypeToJSONSchema(colType) {
  const typeMapping = {
    Null: "null",
    Bool: "boolean",
    Int8: "integer",
    Int16: "integer",
    Int32: "integer",
    Int64: "integer",
    UInt8: "integer",
    UInt16: "integer",
    UInt32: "integer",
    UInt64: "integer",
    Float32: "number",
    Float64: "number",
    Date: "string",
    Datetime: "string",
    Utf8: "string",
    Categorical: "string",
    List: "array",
    Struct: "object",
  };
  // Polars DataTypes only expose their name through toJSON().
  const dataType = typeof colType?.toJSON === "function" ? colType.toJSON()["DataType"] : undefined;
  return typeMapping[dataType] || "string";
}

function extractDataFrame(df) {
  const fields = [];
  for (const [name, colType] of Object.entries(df.schema)) {
    fields.push({ name, type: mapPolarsTypeToJSONSchema(colType) });
  }
  const data = df.head(50).toRecords();
  let html = "<table><thead><tr>";
  for (const field of fields) html += `<th>${escapeHTML(String(field.name))}</th>`;
  html += "</tr></thead><tbody>";
  for (const row of df.head(10).toRecords()) {
    html += "<tr>";
    for (const field of fields) html += `<td>${escapeHTML(String(row[field.name]))}</td>`;
    html += "</tr>";
  }
  html += "</tbody></table>";
  // Polars has `height`; the row count is left out when there isn't one.
  const size = [];
  if (Number.isInteger(df.height)) size.push(`${df.height} ${df.height === 1 ? "row" : "rows"}`);
  size.push(`${fields.length} ${fields.length === 1 ? "column" : "columns"}`);
  const columns = fields.slice(0, 20).map((field) => `${clip(String(field.name), 40)} (${field.type})`);
  if (fields.length > 20) columns.push(`… ${fields.length - 20} more`);
  return {
    "application/vnd.dataresource+json": { data, schema: { fields } },
    "text/html": html,
    "text/plain": `DataFrame (${size.join(", ")})${columns.length ? `: ${columns.join(", ")}` : ""}`,
  };
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
 * }} host
 */
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
    if (isDataFrameLike(obj)) return extractDataFrame(obj);
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

  function broadcast(msgType, content, { metadata = {}, buffers = [] } = {}) {
    host.send(msgType, content, metadata, buffers);
  }

  async function display(obj, options = { raw: false, update: false }) {
    const bundle = options.raw && isMediaBundle(obj) ? obj : await format(obj);
    broadcast(options.update ? "update_display_data" : "display_data", {
      data: bundle,
      metadata: {},
      transient: options.display_id ? { display_id: options.display_id } : {},
    });
  }

  async function broadcastResult(executionCount, result) {
    if (result === undefined) return;
    try {
      broadcast("execute_result", {
        execution_count: executionCount,
        data: await format(result),
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

  const comms = createComms((msgType, content, metadata, buffers) => host.send(msgType, content, metadata, buffers));

  return {
    namespace: {
      broadcast,
      display,
      format,
      md: taggedTemplate("text/markdown"),
      html: taggedTemplate("text/html"),
      svg: taggedTemplate("image/svg+xml"),
      image,
      $display,
      comm: comms.api,
      widget: createWidgetFactory(comms.api, $display),
    },
    broadcastResult,
    formatNow,
    confirm,
    prompt,
    commDispatch: comms.dispatch,
  };
}
