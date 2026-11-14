// @ts-self-types="./table-paging.d.mts"
// Paging a table through the kernel (ganymede#747): a table output embeds
// at most `limit` rows; past that, the frontend asks the kernel for the
// rest over a comm, a page at a time, sorted by a column if it likes.
//
// A table cut by the cap is kept here under an id, which the output names
// as `ganymede.page`. The frontend opens a comm to PAGE_TARGET with
// `{ id }` and sends `{ request, offset, limit, sort? }`; the kernel answers
// `{ request, offset, total, rows }`, rows as arrays in field order and
// encoded as the embedded rows are, or `{ request, error }`. An id the
// kernel no longer has (it restarted, or the table was evicted) gets
// `{ error }` and the comm closes, and the frontend keeps to the rows the
// output embeds.
//
// The kernel keeps the last KEEP tables shown, so a notebook that draws
// many doesn't hold every one; an update of a display keeps its id. Each
// request looks its table up again, so an open comm doesn't keep an
// evicted table alive. Sorting reads the whole column, so it is offered up
// to MAX_SORT rows; the last SORTS orders are kept, so flipping a column's
// direction doesn't sort again.
//
// A table is the live value, not a copy: change it in a later cell and
// its pages show the change (run the cell again to match).

import { encodeRow, encodeValue } from "./table.mjs";

export const PAGE_TARGET = "ganymede.table.v1";
export const KEEP = 16;
export const MAX_PAGE = 1000;
export const MAX_SORT = 1_000_000;
const CHUNK = 10_000;
const SORTS = 2;

const NUMERIC = new Set(["integer", "number"]);
const INTEGER_TEXT = /^-?\d+$/;

function sortNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}

function textOf(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

const collator = new Intl.Collator(undefined, { numeric: true });

/**
 * Compares two encoded values of a column, as the Ganymede apps' table does:
 * nulls, and values that aren't numbers in a numeric column (such as
 * "NaN"), last in either direction; integers past 2^53, sent as strings,
 * exactly.
 */
export function compareEncoded(a, b, type, descending = false) {
  const numeric = NUMERIC.has(type) || (typeof a === "number" && typeof b === "number");
  const last = (v) => v === null || v === undefined || (numeric && Number.isNaN(sortNumber(v)));
  const aLast = last(a);
  const bLast = last(b);
  if (aLast || bLast) return aLast === bLast ? 0 : aLast ? 1 : -1;
  const sign = descending ? -1 : 1;
  if (numeric) {
    if (typeof a === "string" && typeof b === "string" && INTEGER_TEXT.test(a) && INTEGER_TEXT.test(b)) {
      const x = BigInt(a);
      const y = BigInt(b);
      return sign * (x < y ? -1 : x > y ? 1 : 0);
    }
    return sign * (sortNumber(a) - sortNumber(b));
  }
  if (typeof a === "boolean" && typeof b === "boolean") return sign * (Number(a) - Number(b));
  return sign * collator.compare(textOf(a), textOf(b));
}

/**
 * Keeps tables for paging and answers the frontend's comm.
 * @param {import("./comm.d.mts").CommApi} commApi
 * @param {{ keep?: number, newId?: () => string }} [options]
 */
export function createTablePager(commApi, { keep = KEEP, newId = () => crypto.randomUUID() } = {}) {
  /** id -> { source, fields, key?, orders: Map<sortKey, index> } */
  const tables = new Map();
  /** display id -> table id */
  const keyed = new Map();

  function register(source, fields, key) {
    let id = key === undefined ? undefined : keyed.get(key);
    if (id === undefined || !tables.has(id)) id = newId();
    if (key !== undefined) keyed.set(key, id);
    tables.delete(id);
    tables.set(id, { source, fields, key, orders: new Map() });
    while (tables.size > keep) {
      const [oldest, entry] = tables.entries().next().value;
      tables.delete(oldest);
      if (entry.key !== undefined && keyed.get(entry.key) === oldest) keyed.delete(entry.key);
    }
    return id;
  }

  function encodeRows(entry, raw) {
    return raw.map((r) => encodeRow(entry.source, entry.fields, r));
  }

  /** Row indexes in sorted order, kept for the last SORTS sorts asked for. */
  function orderFor(entry, column, descending) {
    const key = `${column}\u0000${descending}`;
    const kept = entry.orders.get(key);
    if (kept) return kept;
    const { source, fields } = entry;
    const c = fields.findIndex((f) => f.name === column);
    if (c < 0) throw new Error(`no column ${JSON.stringify(column)}`);
    if (source.total > MAX_SORT) throw new Error(`sorting is offered up to ${MAX_SORT.toLocaleString("en-US")} rows`);
    const type = fields[c].type;
    const declared = source.columns[c].declared;
    const values = new Array(source.total);
    for (let start = 0; start < source.total; start += CHUNK) {
      const raw = source.read(start, Math.min(start + CHUNK, source.total));
      raw.forEach((r, i) => (values[start + i] = encodeValue(r[c], type, declared)));
    }
    const index = Array.from({ length: source.total }, (_, i) => i);
    // Array sort is stable: ties keep the source's order.
    index.sort((i, j) => compareEncoded(values[i], values[j], type, descending));
    entry.orders.set(key, index);
    while (entry.orders.size > SORTS) entry.orders.delete(entry.orders.keys().next().value);
    return index;
  }

  function page(entry, { offset, limit, sort }) {
    const { source } = entry;
    const start = Math.max(0, Math.min(offset, source.total));
    const end = Math.min(source.total, start + Math.min(limit, MAX_PAGE));
    if (!sort) return encodeRows(entry, source.read(start, end));
    const index = orderFor(entry, String(sort.column), sort.descending === true).slice(start, end);
    // Sorted rows are scattered in the source: read each run of
    // neighbouring rows at once (a run is the whole page when the sort
    // keeps the source's order).
    const rows = [];
    for (let i = 0; i < index.length; ) {
      let j = i + 1;
      while (j < index.length && index[j] === index[j - 1] + 1) j++;
      rows.push(...source.read(index[i], index[j - 1] + 1));
      i = j;
    }
    return encodeRows(entry, rows);
  }

  const gone = "The kernel no longer has this table: run the cell again to page through it.";

  commApi.registerTarget(PAGE_TARGET, (comm, msg) => {
    const id = msg.data?.id;
    if (typeof id !== "string" || !tables.has(id)) {
      comm.send({ error: gone });
      comm.close();
      return;
    }
    comm.onMsg(({ data }) => {
      const request = data?.request;
      // Looked up each time: the comm holds the id, not the table.
      const entry = tables.get(id);
      if (!entry) {
        comm.send({ request, error: gone });
        comm.close();
        return;
      }
      const offset = data?.offset;
      const limit = data?.limit ?? MAX_PAGE;
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) {
        comm.send({ request, error: "offset and limit must be whole numbers" });
        return;
      }
      try {
        const rows = page(entry, { offset, limit, sort: data?.sort ?? undefined });
        comm.send({ request, offset, total: entry.source.total, rows });
      } catch (err) {
        comm.send({ request, error: err instanceof Error ? err.message : String(err) });
      }
    });
  });

  return { register, size: () => tables.size };
}
