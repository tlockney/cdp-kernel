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

import { encodeValue, fieldsOf, tableBundle, tableSource } from "./table.mjs";

export const NODE_API = "npm:@duckdb/node-api@1.5.6-r.2";
export const DUCKDB_WASM = "npm:@duckdb/duckdb-wasm@1.29.0";

const $display = Symbol.for("Jupyter.display");
const RAW = Symbol("cdpk.sql.raw");

/** A value from DuckDB as plain JavaScript: safe bigints as numbers. */
function jsValue(value, declared) {
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

/** An Arrow decimal's little-endian 32-bit words, scaled, as a number. */
export function decimalValue(words, scale) {
  if (typeof words === "number" || typeof words === "bigint") return Number(words) / 10 ** scale;
  const list = Array.from(words);
  let big = 0n;
  list.forEach((w, i) => (big |= BigInt(w >>> 0) << BigInt(32 * i)));
  const bits = BigInt(32 * list.length);
  if (list.length && list.at(-1) >>> 31) big -= 1n << bits;
  return Number(big) / 10 ** scale;
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
    const e = await open();
    const s = signal?.();
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

/** Rows, an Arrow table or a DataFrame as JSON and a from_json structure. */
export function rowsAsJson(source) {
  const src = tableSource(source);
  const raw = src.read(0, src.total);
  const fields = fieldsOf(src, raw);
  if (fields.length === 0) return { structure: null, json: "[]" };
  const rows = raw.map((r) => {
    const obj = {};
    fields.forEach((f, i) => {
      let v = encodeValue(r[i], f.type);
      // DOUBLE takes no "NaN" text from JSON; null instead.
      if ((f.type === "number" || f.type === "integer") && typeof v === "string" && !/^-?\d+$/.test(v)) v = null;
      obj[f.name] = v;
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
  const { DuckDBInstance } = await importModule(NODE_API);
  const db = await DuckDBInstance.create(":memory:");
  const conn = await db.connect();
  return {
    connection: conn,
    interrupt: () => conn.interrupt?.(),
    async query(text, params) {
      const result = await conn.runAndReadAll(text, params);
      const types = result.columnTypes();
      const columns = result.columnNames().map((name, i) => ({ name, type: String(types[i]) }));
      const rows = result.getRowObjectsJS().map((row) => {
        const out = {};
        for (const c of columns) out[c.name] = jsValue(row[c.name], c.type);
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
  return {
    connection: conn,
    interrupt: () => void conn.cancelSent?.(),
    async query(text, params) {
      let table;
      if (params.length === 0) table = await conn.query(text);
      else {
        const statement = await conn.prepare(text);
        try {
          table = await statement.query(...params);
        } finally {
          await statement.close();
        }
      }
      const fields = table.schema.fields;
      const columns = fields.map((f) => ({ name: f.name, type: String(f.type) }));
      const vectors = columns.map((c) => table.getChild(c.name));
      // Arrow gives a DECIMAL as its 128-bit words; DuckDB's native build
      // gives a number, so this does too.
      const decimal = fields.map((f) => (/^decimal/i.test(String(f.type)) ? f.type.scale ?? 0 : null));
      const rows = [];
      for (let i = 0; i < table.numRows; i++) {
        const row = {};
        columns.forEach((c, j) => {
          const v = vectors[j]?.get(i);
          row[c.name] = decimal[j] !== null && v != null ? decimalValue(v, decimal[j]) : jsValue(v, c.type);
        });
        rows.push(row);
      }
      return new SqlResult(columns, rows);
    },
    async close() {
      await conn.close();
      await db.terminate();
      worker.terminate();
    },
  };
}
