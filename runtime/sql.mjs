// @ts-self-types="./sql.d.mts"
// jupyter.sql (cdp-kernel#477, ganymede#747): a tagged template over an
// in-memory DuckDB, whose results show as table output (table.mjs).
//
//   const rows = await jupyter.sql`select * from trips where riders > ${min}`;
//
// Template values become bound parameters, never query text; sql.raw()
// is the explicit way to put text in. One database per kernel, opened on
// the first query, as ganymede-ui's DuckDB example does (ganymede-ui#559):
// DuckDB's native build, @duckdb/node-api, on Node, Deno and Bun, and its
// WebAssembly build in a Worker of its own in the browser target (the
// apps' in-app kernel). The packages load through the cell's own import,
// so npm: resolution and the browser target's CDN apply as in a cell.
//
// No static imports beyond table.mjs: this file must load in every target.

import { fieldsOf, tableBundle, tableSource, timeText, uniqueNames } from "./table.mjs";

export { timeText, uniqueNames };

export const NODE_API = "npm:@duckdb/node-api@1.5.6-r.2";
export const DUCKDB_WASM = "npm:@duckdb/duckdb-wasm@1.29.0";

const $display = Symbol.for("Jupyter.display");
const RAW = Symbol("cdpk.sql.raw");

/** A value from DuckDB as plain JavaScript: safe bigints as numbers. */
function jsValue(value, declared) {
  if (/^time(?!stamp)/i.test(declared ?? "") && (typeof value === "bigint" || typeof value === "number")) {
    return timeText(value, declared);
  }
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value;
  if (typeof value === "number" && /^(date|timestamp)/i.test(declared ?? "")) return new Date(value);
  if (Array.isArray(value)) return value.map((v) => jsValue(v));
  if (value !== null && typeof value === "object" && !(value instanceof Date) && !ArrayBuffer.isView(value)) {
    if (typeof value.toJSON === "function" && !(Symbol.iterator in value) && Object.getPrototypeOf(value) !== Object.prototype) {
      return jsValue(value.toJSON());
    }
    if (typeof value.toArray === "function") return jsValue(Array.from(value.toArray()));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsValue(v);
    return out;
  }
  return value;
}

/**
 * An Arrow decimal's little-endian 32-bit words, scaled, as a number; with
 * no scale (HUGEINT), a bigint when a number can't hold it.
 */
export function decimalValue(words, scale) {
  if (typeof words === "bigint" && scale === 0) return jsValue(words);
  if (typeof words === "number" || typeof words === "bigint") return Number(words) / 10 ** scale;
  const list = Array.from(words);
  let big = 0n;
  list.forEach((w, i) => (big |= BigInt(w >>> 0) << BigInt(32 * i)));
  const bits = BigInt(32 * list.length);
  if (list.length && list.at(-1) >>> 31) big -= 1n << bits;
  return scale === 0 ? jsValue(big) : Number(big) / 10 ** scale;
}

/** A query's result: its columns and rows, shown as a table. */
export class SqlResult {
  /**
   * @param {{ name: string, type: string }[]} columns
   * @param {Record<string, unknown>[]} rows
   */
  constructor(columns, rows) {
    this.columns = columns;
    this.rows = rows;
  }
  /** table.mjs reads this instead of guessing at the shape. */
  toTableSource(names) {
    const columns = names ? this.columns.filter((c) => names.includes(c.name)) : this.columns;
    return {
      columns: columns.map((c) => ({ name: c.name, declared: c.type })),
      total: this.rows.length,
      read: (start, end) => this.rows.slice(start, end).map((row) => columns.map((c) => row[c.name])),
    };
  }
  [$display]() {
    return tableBundle(tableSource(this));
  }
}

/** A JavaScript value as a DuckDB parameter. */
export function toParam(value) {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && value !== null && !ArrayBuffer.isView(value)) return JSON.stringify(value);
  return value;
}

/** Joins a template's strings with `?` for each value, inlining sql.raw(). */
export function compose(strings, values) {
  let text = strings[0];
  const params = [];
  values.forEach((value, i) => {
    if (value !== null && typeof value === "object" && RAW in value) text += value[RAW];
    else {
      text += "?";
      params.push(toParam(value));
    }
    text += strings[i + 1];
  });
  return { text, params };
}

export function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

export function quoteString(text) {
  return `'${String(text).replaceAll("'", "''")}'`;
}

/**
 * A parameter (as toParam leaves it) as a SQL literal. A negative number
 * is parenthesized, since after a minus sign `-1` would make `--`, a
 * comment.
 */
export function sqlLiteral(value) {
  const text = literalText(value);
  return text.startsWith("-") ? `(${text})` : text;
}

function literalText(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "bigint") return `${value}`;
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return String(value);
    return Number.isFinite(value) ? `${value}::DOUBLE` : `'${value}'::DOUBLE`;
  }
  if (value instanceof Uint8Array) {
    return `'${Array.from(value, (b) => `\\x${b.toString(16).padStart(2, "0")}`).join("")}'::BLOB`;
  }
  if (ArrayBuffer.isView(value)) return `[${Array.from(value, (v) => sqlLiteral(v)).join(", ")}]`;
  return quoteString(value);
}

/**
 * The query with each `?` placeholder replaced by its parameter as a
 * literal. A `?` inside a string, a quoted name or a comment is left as it
 * is. duckdb-wasm can cancel only an unprepared query, so it runs this.
 * Dollar-quoted (`$$…$$`) and `E'…'` strings and nested comments aren't
 * recognized: a `?` in one counts as a placeholder, and the count then
 * fails to match the parameters and throws.
 */
export function inlineParams(text, params) {
  if (params.length === 0) return text;
  let out = "";
  let next = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const end =
      c === "'" || c === '"' ? text.indexOf(c, i + 1) :
      c === "-" && text[i + 1] === "-" ? text.indexOf("\n", i) :
      c === "/" && text[i + 1] === "*" ? text.indexOf("*/", i + 2) + 1 :
      undefined;
    if (end !== undefined) {
      // A doubled quote ('it''s') reads as two strings back to back.
      const stop = end < 0 || end === 0 ? text.length : end + 1;
      out += text.slice(i, stop);
      i = stop - 1;
    } else if (c === "?") {
      if (next >= params.length) throw new RangeError("jupyter.sql: more ? placeholders than parameters");
      // A space after a quote, so 'a'? doesn't read as one string 'a''x'.
      if (out.endsWith("'") || out.endsWith('"')) out += " ";
      out += sqlLiteral(params[next++]);
    } else out += c;
  }
  if (next < params.length) throw new RangeError("jupyter.sql: more parameters than ? placeholders");
  return out;
}

const DUCK_TYPES = {
  integer: "BIGINT",
  number: "DOUBLE",
  boolean: "BOOLEAN",
  string: "VARCHAR",
  date: "DATE",
  datetime: "TIMESTAMP",
  time: "TIME",
  array: "JSON",
  object: "JSON",
  duration: "VARCHAR",
};

/**
 * @param {{
 *   importModule: (specifier: string) => Promise<any>,
 *   signal?: () => AbortSignal | undefined,
 *   openEngine?: () => Promise<Engine>,
 * }} options
 *
 * @typedef {{
 *   query: (text: string, params: unknown[]) => Promise<SqlResult>,
 *   interrupt?: () => void,
 *   close: () => Promise<void>,
 *   connection: unknown,
 * }} Engine
 */
export function createSql({ importModule, signal, openEngine }) {
  let engine = null;
  const open = () => (engine ??= (openEngine ?? (() => defaultEngine(importModule)))().catch((err) => {
    engine = null;
    throw err;
  }));

  async function run(text, params) {
    // The cell's signal, read before the first open's wait, so a cell that
    // starts meanwhile doesn't take the query over.
    const s = signal?.();
    const e = await open();
    if (s?.aborted) throw s.reason;
    const onAbort = () => e.interrupt?.();
    s?.addEventListener("abort", onAbort, { once: true });
    try {
      return await e.query(text, params);
    } finally {
      s?.removeEventListener("abort", onAbort);
    }
  }

  function sql(strings, ...values) {
    if (!Array.isArray(strings) || !Array.isArray(strings.raw)) {
      return Promise.reject(new TypeError("jupyter.sql is a tag: jupyter.sql`select ...`; for a string, use jupyter.sql.query(text, params)"));
    }
    const { text, params } = compose(strings, values);
    return run(text, params);
  }

  sql.query = (text, params = []) => {
    if (typeof text !== "string") return Promise.reject(new TypeError("jupyter.sql.query: text must be a string"));
    return run(text, params.map(toParam));
  };

  sql.raw = (text) => ({ [RAW]: String(text) });

  sql.load = async (name, source) => {
    if (typeof name !== "string" || name === "") throw new TypeError("jupyter.sql.load: name must be a non-empty string");
    const table = quoteIdent(name);
    if (typeof source === "string") {
      await run(`create or replace table ${table} as select * from ${quoteString(source)}`, []);
      return;
    }
    const { structure, json } = rowsAsJson(source);
    if (structure === null) {
      throw new TypeError("jupyter.sql.load: the rows have no columns");
    }
    await run(
      `create or replace table ${table} as select unnest(from_json(?, ?), recursive := true)`,
      [json, structure],
    );
  };

  sql.close = async () => {
    const e = engine;
    engine = null;
    if (e) await (await e).close();
  };

  sql.connection = async () => (await open()).connection;

  return sql;
}

/** A value as JSON for loading: nothing clipped, unlike a table's display. */
function loadValue(value, type, depth = 0) {
  if (value === null || value === undefined) return null;
  if (type === "date" || type === "datetime") {
    const d = value instanceof Date ? value : typeof value === "number" || typeof value === "bigint" ? new Date(Number(value)) : null;
    if (d) return Number.isNaN(d.getTime()) ? null : type === "date" ? d.toISOString().slice(0, 10) : d.toISOString();
  }
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  // DOUBLE takes no "NaN" text from JSON; null instead.
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object") return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (depth > 64) throw new TypeError("jupyter.sql.load: a value is nested more than 64 levels deep");
  if (ArrayBuffer.isView(value) && !(value instanceof DataView) && value.BYTES_PER_ELEMENT === 1) {
    // Bytes as base64 text: JSON has no binary.
    let text = "";
    for (const byte of value) text += String.fromCharCode(byte);
    return btoa(text);
  }
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value, (v) => loadValue(v, undefined, depth + 1));
  if (typeof value.toJSON === "function" && Object.getPrototypeOf(value) !== Object.prototype) {
    return loadValue(value.toJSON(), undefined, depth + 1);
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = loadValue(v, undefined, depth + 1);
  return out;
}

/** Rows, an Arrow table or a DataFrame as JSON and a from_json structure. */
export function rowsAsJson(source) {
  const src = tableSource(source);
  const raw = src.read(0, src.total);
  const fields = fieldsOf(src, raw);
  if (fields.length === 0) return { structure: null, json: "[]" };
  const rows = raw.map((r) => {
    const obj = {};
    fields.forEach((f, i) => {
      obj[f.name] = loadValue(r[i], f.type);
    });
    return obj;
  });
  const structure = {};
  for (const f of fields) structure[f.name] = DUCK_TYPES[f.type] ?? "VARCHAR";
  return { structure: JSON.stringify([structure]), json: JSON.stringify(rows) };
}

function inWorker() {
  return typeof globalThis.WorkerGlobalScope === "function" && globalThis instanceof globalThis.WorkerGlobalScope;
}

function hasNativeRuntime() {
  return typeof globalThis.Deno?.version?.deno === "string" || typeof globalThis.Bun?.version === "string" ||
    typeof globalThis.process?.versions?.node === "string" && !inWorker();
}

async function defaultEngine(importModule) {
  if (hasNativeRuntime()) return nativeEngine(importModule);
  if (inWorker() && typeof Worker === "function") return wasmEngine(importModule);
  throw new Error("jupyter.sql needs Node, Deno, Bun or the browser target; workerd and celld have no DuckDB");
}

async function nativeEngine(importModule) {
  const { DuckDBInstance, blobValue } = await importModule(NODE_API);
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  return {
    connection: conn,
    interrupt: () => conn.interrupt?.(),
    async query(text, params) {
      // Bytes need a declared BLOB; the rest bind by their JavaScript type.
      const bound = params.map((p) => (p instanceof Uint8Array && blobValue ? blobValue(p) : p));
      const result = await conn.runAndReadAll(text, bound);
      const types = result.columnTypes();
      const columns = uniqueNames(result.columnNames()).map((name, i) => ({ name, type: String(types[i]) }));
      // By position, as two columns may share a name.
      const rows = result.getRowsJS().map((row) => {
        const out = {};
        columns.forEach((c, j) => (out[c.name] = jsValue(row[j], c.type)));
        return out;
      });
      return new SqlResult(columns, rows);
    },
    async close() {
      conn.closeSync?.();
      db.closeSync?.();
    },
  };
}

async function wasmEngine(importModule) {
  const duckdb = await importModule(DUCKDB_WASM);
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  // A Worker can only start from its own origin's scripts, so a Blob
  // script loads DuckDB's.
  const loader = URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(bundle.mainWorker)});`], { type: "text/javascript" }));
  const worker = new Worker(loader);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(loader);
  const conn = await db.connect();
  let cancelled = false;
  return {
    connection: conn,
    interrupt: () => {
      cancelled = true;
      void conn.cancelSent?.();
    },
    async query(text, params) {
      // send() streams the result, which cancelSent() can stop; query()
      // runs to the end in the worker whatever is asked of it, and so
      // does a prepared statement's send(). So the parameters go into the
      // text as literals, and the batch loop stops on an interrupt too.
      cancelled = false;
      const reader = await conn.send(inlineParams(text, params), true);
      const stop = () => {
        if (cancelled) throw new DOMException("The query was interrupted", "AbortError");
      };
      try {
        stop();
        const columns = [];
        const rows = [];
        let decimal = [];
        for await (const batch of reader) {
          if (columns.length === 0 && batch.schema.fields.length) {
            const fields = batch.schema.fields;
            uniqueNames(fields.map((f) => f.name)).forEach((name, j) => columns.push({ name, type: String(fields[j].type) }));
            // Arrow gives a DECIMAL as its 128-bit words; DuckDB's native
            // build gives a number, so this does too.
            decimal = fields.map((f) => (/^decimal/i.test(String(f.type)) ? f.type.scale ?? 0 : null));
          }
          stop();
          const vectors = columns.map((_, j) => batch.getChildAt(j));
          for (let i = 0; i < batch.numRows; i++) {
            const row = {};
            columns.forEach((c, j) => {
              const v = vectors[j]?.get(i);
              row[c.name] = decimal[j] !== null && v != null ? decimalValue(v, decimal[j]) : jsValue(v, c.type);
            });
            rows.push(row);
          }
        }
        if (columns.length === 0 && reader.schema?.fields) {
          const fields = reader.schema.fields;
          uniqueNames(fields.map((f) => f.name)).forEach((name, j) => columns.push({ name, type: String(fields[j].type) }));
        }
        return new SqlResult(columns, rows);
      } catch (err) {
        await Promise.resolve((reader.cancel ?? reader.return)?.call(reader)).catch(() => {});
        throw err;
      }
    },
    async close() {
      await conn.close();
      await db.terminate();
      worker.terminate();
    },
  };
}
