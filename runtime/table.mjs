// @ts-self-types="./table.d.mts"
// Table output (cdp-kernel#475, ganymede#747): a value with rows and
// columns as one MIME bundle every reader can show. The design is
// Ganymede's docs/data-output.md:
//   - application/vnd.dataresource+json: Table Schema fields and up to
//     `limit` rows as JSON, plus `ganymede: { rows, shown }`, which the
//     Ganymede apps render with sorting and paging;
//   - text/html: a plain table, head and tail rows, for JupyterLab, VS Code
//     and GitHub;
//   - text/plain: shape, column types and ranges, and numbered head and
//     tail rows, for agents and consoles.
// Sources: arrays of row objects or arrays, Arrow tables (apache-arrow,
// duckdb-wasm), Polars DataFrames and @duckdb/node-api results.
//
// No imports: this file must load in every target.

export const TABLE_MIME = "application/vnd.dataresource+json";
export const DEFAULT_LIMIT = 1000;
export const MAX_LIMIT = 10_000;
/** Embedded rows stop at this much JSON, whatever the limit. */
export const MAX_BYTES = 1_000_000;
/** A longer string is cut, with "…". */
export const MAX_CELL = 1000;
const HTML_ALL = 20;
const HTML_HEAD = 10;
const HTML_TAIL = 5;
const TEXT_HEAD = 3;
const TEXT_TAIL = 2;
const TEXT_COLUMNS = 20;
const TEXT_MAX = 4096;

const rawToEntity = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHTML = (s) => s.replace(/[&<>"']/g, (c) => rawToEntity[c]);

function isObject(value) {
  return value !== null && typeof value === "object";
}

export function isArrowTable(value) {
  return isObject(value) && isObject(value.schema) && Array.isArray(value.schema.fields) &&
    typeof value.numRows === "number" && typeof value.getChild === "function";
}

export function isPolarsFrame(value) {
  return isObject(value) && isObject(value.schema) && typeof value.head === "function" &&
    typeof value.toRecords === "function";
}

export function isDuckDBResult(value) {
  return isObject(value) && typeof value.columnNames === "function" && typeof value.columnTypes === "function" &&
    typeof value.getRowObjectsJS === "function";
}

/** Whether `value` shows as a table when it is a cell's value. */
export function isTableLike(value) {
  return isArrowTable(value) || isPolarsFrame(value) || isDuckDBResult(value);
}

// --- Types ------------------------------------------------------------------

/** A declared column type (Arrow, Polars or DuckDB) as a Table Schema type. */
export function schemaType(declared) {
  const t = String(declared ?? "");
  if (t === "") return undefined;
  if (/^(list|large_?list|fixed_?size_?list|array)\b|\[\]$/i.test(t)) return "array";
  if (/^(struct|map|union|json)\b/i.test(t)) return "object";
  if (/^(u?int\d*|u?(tiny|small|big|huge)?int(eger)?)\b/i.test(t)) return "integer";
  if (/^(float\d*|double|real|decimal|numeric)\b/i.test(t)) return "number";
  if (/^bool/i.test(t)) return "boolean";
  if (/^date(32|64)?(<|$|\b(?!time))/i.test(t) && !/^datetime/i.test(t)) return "date";
  if (/^(timestamp|datetime)/i.test(t)) return "datetime";
  if (/^time/i.test(t)) return "time";
  if (/^(interval|duration)/i.test(t)) return "duration";
  if (/^(utf8|large_?utf8|string|varchar|char|text|categorical|enum|uuid|null)\b/i.test(t)) return "string";
  return undefined;
}

function polarsDeclared(dtype) {
  // Polars DataTypes only expose their name through toJSON().
  if (typeof dtype?.toJSON === "function") {
    const json = dtype.toJSON();
    const name = isObject(json) ? json.DataType ?? Object.keys(json)[0] : json;
    if (typeof name === "string") return name;
    if (isObject(name)) return Object.keys(name)[0];
  }
  return typeof dtype === "string" ? dtype : undefined;
}

function inferType(values) {
  let type;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    let t;
    if (typeof v === "bigint") t = "integer";
    else if (typeof v === "number") t = Number.isInteger(v) ? "integer" : "number";
    else if (typeof v === "boolean") t = "boolean";
    else if (typeof v === "string") t = "string";
    else if (v instanceof Date) t = "datetime";
    else if (Array.isArray(v) || ArrayBuffer.isView(v)) t = ArrayBuffer.isView(v) && !(v instanceof DataView) && v.BYTES_PER_ELEMENT === 1 ? "string" : "array";
    else t = "object";
    if (type === undefined) type = t;
    else if (type !== t) {
      if ((type === "integer" && t === "number") || (type === "number" && t === "integer")) type = "number";
      else return "string";
    }
  }
  return type ?? "string";
}

// --- Values -----------------------------------------------------------------

function clipString(s, max = MAX_CELL) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" || typeof value === "bigint") {
    const d = new Date(Number(value));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** A nested value as JSON-safe data: bigints as numbers or strings. */
function plain(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return clipString(value);
  if (typeof value !== "object") return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (depth > 8) return "…";
  if (ArrayBuffer.isView(value) && !(value instanceof DataView) && value.BYTES_PER_ELEMENT === 1) {
    return `<${value.byteLength} bytes>`;
  }
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value, (v) => plain(v, depth + 1));
  // Arrow vectors and struct rows.
  if (typeof value.toJSON === "function") return plain(value.toJSON(), depth + 1);
  if (typeof value.toArray === "function") return plain(value.toArray(), depth + 1);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = plain(v, depth + 1);
  return out;
}

/** One cell as Table Schema JSON for a column of `type`. */
export function encodeValue(value, type) {
  if (value === null || value === undefined) return null;
  if (type === "date" || type === "datetime") {
    const d = toDate(value);
    if (d) return type === "date" ? d.toISOString().slice(0, 10) : d.toISOString();
  }
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
    return value;
  }
  if (typeof value === "string") return clipString(value);
  if (typeof value === "boolean") return value;
  return plain(value);
}

// --- Sources ----------------------------------------------------------------

/**
 * @typedef {{ name: string, declared?: string }} Column
 * @typedef {{ columns: Column[], total: number, read: (start: number, end: number) => unknown[][] }} Source
 */

function fromObjects(rows, names) {
  let columns = names;
  if (!columns) {
    const seen = new Set();
    for (const row of rows.slice(0, DEFAULT_LIMIT)) {
      if (isObject(row)) for (const key of Object.keys(row)) seen.add(key);
    }
    columns = [...seen];
  }
  return {
    columns: columns.map((name) => ({ name: String(name) })),
    total: rows.length,
    read: (start, end) => rows.slice(start, end).map((row) => columns.map((c) => (isObject(row) ? row[c] : undefined))),
  };
}

function fromArrays(rows, names) {
  const width = names?.length ?? Math.max(0, ...rows.slice(0, DEFAULT_LIMIT).map((r) => (Array.isArray(r) ? r.length : 0)));
  const columns = names ?? Array.from({ length: width }, (_, i) => String(i));
  return {
    columns: columns.map((name) => ({ name: String(name) })),
    total: rows.length,
    read: (start, end) => rows.slice(start, end).map((row) => columns.map((_, i) => (Array.isArray(row) ? row[i] : undefined))),
  };
}

function fromArrow(table, names) {
  const fields = table.schema.fields.filter((f) => !names || names.includes(f.name));
  const vectors = fields.map((f) => table.getChild(f.name));
  return {
    columns: fields.map((f) => ({ name: String(f.name), declared: String(f.type) })),
    total: table.numRows,
    read(start, end) {
      const out = [];
      for (let i = start; i < Math.min(end, table.numRows); i++) out.push(vectors.map((v) => v?.get(i)));
      return out;
    },
  };
}

function fromPolars(df, names) {
  const columns = Object.entries(df.schema)
    .filter(([name]) => !names || names.includes(name))
    .map(([name, dtype]) => ({ name, declared: polarsDeclared(dtype) }));
  const total = Number.isInteger(df.height) ? df.height : df.toRecords().length;
  const records = (start, end) =>
    typeof df.slice === "function" ? df.slice(start, end - start).toRecords() : df.toRecords().slice(start, end);
  return {
    columns,
    total,
    read: (start, end) => records(start, Math.min(end, total)).map((row) => columns.map((c) => row[c.name])),
  };
}

function fromDuckDB(result, names) {
  const types = result.columnTypes();
  const all = result.columnNames().map((name, i) => ({ name, declared: String(types[i]) }));
  const columns = names ? all.filter((c) => names.includes(c.name)) : all;
  let rows;
  const get = () => (rows ??= result.getRowObjectsJS());
  return {
    columns,
    total: typeof result.rowCount === "number" ? result.rowCount : get().length,
    read: (start, end) => get().slice(start, end).map((row) => columns.map((c) => row[c.name])),
  };
}

/** A table's columns and rows, from any source `jupyter.table` takes. */
export function tableSource(value, options = {}) {
  const names = Array.isArray(options.columns) ? options.columns.map(String) : undefined;
  if (isObject(value) && typeof value.toTableSource === "function") return value.toTableSource(names);
  if (isArrowTable(value)) return fromArrow(value, names);
  if (isPolarsFrame(value)) return fromPolars(value, names);
  if (isDuckDBResult(value)) return fromDuckDB(value, names);
  if (Array.isArray(value)) {
    const first = value.find((row) => row !== null && row !== undefined);
    return Array.isArray(first) ? fromArrays(value, names) : fromObjects(value, names);
  }
  throw new TypeError(
    "jupyter.table takes an array of rows, an Arrow table, a Polars DataFrame or a DuckDB result",
  );
}

// --- The bundle -------------------------------------------------------------

function count(n, noun) {
  return `${n.toLocaleString("en-US")} ${n === 1 ? noun : `${noun}s`}`;
}

function shortValue(v) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return clipString(s.replace(/\s+/g, " "), 30);
}

function columnStats(rows, i, type) {
  let nulls = 0;
  const values = [];
  for (const row of rows) {
    const v = row[i];
    if (v === null) nulls++;
    else values.push(v);
  }
  let range = "";
  if (values.length) {
    if (type === "integer" || type === "number") {
      const nums = values.map(Number).filter(Number.isFinite);
      if (nums.length) {
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        const fmt = (n) => (Number.isInteger(n) ? n.toLocaleString("en-US") : String(Number(n.toPrecision(6))));
        range = min === max ? fmt(min) : `${fmt(min)} to ${fmt(max)}`;
      }
    } else if (type === "date" || type === "datetime" || type === "time") {
      const sorted = values.map(String).sort();
      range = sorted[0] === sorted.at(-1) ? sorted[0] : `${sorted[0]} to ${sorted.at(-1)}`;
    } else if (type === "boolean") {
      const t = values.filter((v) => v === true).length;
      range = `${t} true, ${values.length - t} false`;
    } else {
      const distinct = new Set(values.map((v) => (typeof v === "string" ? v : JSON.stringify(v)))).size;
      range = count(distinct, "value");
    }
  }
  return [range, nulls ? count(nulls, "null") : ""].filter(Boolean).join(", ");
}

function htmlTable(fields, head, tail, total, title) {
  let html = "<table>";
  if (title) html += `<caption>${escapeHTML(title)}</caption>`;
  html += "<thead><tr>";
  for (const f of fields) {
    html += `<th>${escapeHTML(f.name)}<br><small>${escapeHTML(f.type)}</small></th>`;
  }
  html += "</tr></thead><tbody>";
  const row = (r) => {
    let s = "<tr>";
    fields.forEach((f, i) => {
      const v = r[i];
      const text = v === null ? "" : typeof v === "string" ? v : JSON.stringify(v);
      const align = f.type === "integer" || f.type === "number" ? ' style="text-align:right"' : "";
      s += `<td${align}>${escapeHTML(text)}</td>`;
    });
    return `${s}</tr>`;
  };
  for (const r of head) html += row(r);
  const hidden = total - head.length - tail.length;
  if (hidden > 0) html += `<tr><td colspan="${Math.max(1, fields.length)}">… ${count(hidden, "more row")}</td></tr>`;
  for (const r of tail) html += row(r);
  return `${html}</tbody></table>`;
}

function textTable(fields, numbered) {
  const cells = numbered.map(([n, r]) => [String(n), ...r.map(shortValue)]);
  const widths = [0, ...fields.map(() => 0)];
  for (const row of cells) row.forEach((c, i) => (widths[i] = Math.max(widths[i], c.length)));
  return cells.map((row) => `  ${row.map((c, i) => c.padEnd(widths[i])).join(" | ").trimEnd()}`);
}

/**
 * The MIME bundle for a table: Table Schema JSON with up to `limit` rows,
 * an HTML table and a text summary.
 */
export function tableBundle(source, options = {}) {
  const requested = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(requested) || requested < 0) throw new TypeError("jupyter.table: limit must be a whole number");
  const limit = Math.min(requested, MAX_LIMIT);
  const title = typeof options.title === "string" && options.title !== "" ? options.title : undefined;
  const total = source.total;

  const raw = source.read(0, Math.min(limit, total));
  const fields = source.columns.map((c, i) => ({
    name: c.name,
    type: schemaType(c.declared) ?? inferType(raw.map((r) => r[i])),
  }));
  const encode = (r) => fields.map((f, i) => encodeValue(r[i], f.type));

  // Rows as JSON, stopping at MAX_BYTES.
  const encoded = [];
  const data = [];
  let bytes = 0;
  for (const r of raw) {
    const values = encode(r);
    const obj = {};
    fields.forEach((f, i) => (obj[f.name] = values[i]));
    bytes += JSON.stringify(obj).length + 1;
    if (bytes > MAX_BYTES && data.length > 0) break;
    encoded.push(values);
    data.push(obj);
  }
  const shown = data.length;

  // Head and tail rows, the tail from the source itself.
  const split = total > HTML_ALL;
  const htmlHead = split ? encoded.slice(0, HTML_HEAD) : encoded.slice(0, total);
  const htmlTail = split ? source.read(total - HTML_TAIL, total).map(encode) : [];
  const textSplit = total > TEXT_HEAD + TEXT_TAIL;
  const textHeadRows = encoded.slice(0, textSplit ? TEXT_HEAD : total);
  const textTail = !textSplit ? [] : htmlTail.length ? htmlTail.slice(-TEXT_TAIL) : source.read(total - TEXT_TAIL, total).map(encode);

  // Text summary.
  const lines = [];
  const name = title ? `Table "${clipString(title, 80)}"` : "Table";
  const shape = `${count(total, "row")}, ${count(fields.length, "column")}`;
  lines.push(`${name} (${shape}${shown < total ? `; ${shown.toLocaleString("en-US")} shown` : ""})`);
  if (fields.length) {
    lines.push(shown < total ? `Columns (ranges over the first ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} rows):` : "Columns:");
    const nameWidth = Math.min(30, Math.max(...fields.slice(0, TEXT_COLUMNS).map((f) => f.name.length)));
    const typeWidth = Math.max(...fields.slice(0, TEXT_COLUMNS).map((f) => f.type.length));
    fields.slice(0, TEXT_COLUMNS).forEach((f, i) => {
      const stats = columnStats(encoded, i, f.type);
      lines.push(`  ${clipString(f.name, 30).padEnd(nameWidth)}  ${f.type.padEnd(typeWidth)}  ${stats}`.trimEnd());
    });
    if (fields.length > TEXT_COLUMNS) lines.push(`  … ${count(fields.length - TEXT_COLUMNS, "more column")}`);
    const numbered = [
      ...textHeadRows.map((r, i) => [i, r]),
      ...textTail.map((r, i) => [total - textTail.length + i, r]),
    ];
    if (numbered.length) {
      lines.push("Rows:");
      const table = textTable(fields.slice(0, TEXT_COLUMNS), numbered.map(([n, r]) => [n, r.slice(0, TEXT_COLUMNS)]));
      if (textTail.length) table.splice(textHeadRows.length, 0, "  …");
      lines.push(...table);
    }
  }
  let text = lines.join("\n");
  if (text.length > TEXT_MAX) text = `${text.slice(0, TEXT_MAX - 1)}…`;

  /** @type {Record<string, unknown>} */
  const resource = { schema: { fields }, data, ganymede: { rows: total, shown } };
  if (title) resource.ganymede.title = title;
  return {
    [TABLE_MIME]: resource,
    "text/html": htmlTable(fields, htmlHead, htmlTail, total, title),
    "text/plain": text,
  };
}
