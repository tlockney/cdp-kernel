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
  return { [mediaType]: spec };
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
  return {
    "application/vnd.dataresource+json": { data, schema: { fields } },
    "text/html": html,
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
