import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeValue, MAX_LIMIT, schemaType, tableBundle, tableSource, TABLE_MIME } from "../runtime/table.mjs";

type Resource = {
  schema: { fields: { name: string; type: string }[] };
  data: Record<string, unknown>[];
  ganymede: { rows: number; shown: number; title?: string };
};

function table(value: unknown, options: { limit?: number; columns?: string[]; title?: string } = {}) {
  const bundle = tableBundle(tableSource(value, options), options);
  return {
    resource: bundle[TABLE_MIME] as Resource,
    html: bundle["text/html"] as string,
    text: bundle["text/plain"] as string,
  };
}

test("rows of objects: columns in first-seen order, types inferred", () => {
  const { resource } = table([
    { a: 1, b: "x" },
    { a: 2.5, c: true },
    { a: null, b: "y", c: false },
  ]);
  assert.deepEqual(resource.schema.fields, [
    { name: "a", type: "number" },
    { name: "b", type: "string" },
    { name: "c", type: "boolean" },
  ]);
  assert.deepEqual(resource.data[1], { a: 2.5, b: null, c: true });
  assert.deepEqual(resource.ganymede, { rows: 3, shown: 3 });
});

test("rows of arrays take names from columns", () => {
  const { resource } = table([[1, "a"], [2, "b"]], { columns: ["n", "s"] });
  assert.deepEqual(resource.schema.fields.map((f) => f.name), ["n", "s"]);
  assert.deepEqual(resource.data[0], { n: 1, s: "a" });
  assert.deepEqual(table([[1, 2]]).resource.schema.fields.map((f) => f.name), ["0", "1"]);
});

test("values: bigints, non-finite numbers, dates, long strings, bytes and nesting", () => {
  assert.equal(encodeValue(5n, "integer"), 5);
  assert.equal(encodeValue(2n ** 60n, "integer"), "1152921504606846976");
  assert.equal(encodeValue(Number.NaN, "number"), "NaN");
  assert.equal(encodeValue(-Infinity, "number"), "-Infinity");
  assert.equal(encodeValue(new Date("2026-11-13T10:00:00Z"), "date"), "2026-11-13");
  assert.equal(encodeValue(new Date("2026-11-13T10:00:00Z"), "datetime"), "2026-11-13T10:00:00.000Z");
  assert.equal(encodeValue(Date.UTC(2020, 0, 2), "date"), "2020-01-02");
  assert.equal((encodeValue("x".repeat(2000), "string") as string).length, 1000);
  assert.equal(encodeValue(new Uint8Array(12), "string"), "<12 bytes>");
  assert.deepEqual(encodeValue({ a: [1n, new Date(0)] }, "object"), { a: [1, "1970-01-01T00:00:00.000Z"] });
  assert.equal(encodeValue(undefined, "string"), null);
});

test("declared types map to Table Schema types", () => {
  const cases: [string, string | undefined][] = [
    ["Int64", "integer"], ["BIGINT", "integer"], ["UInt8", "integer"], ["HUGEINT", "integer"],
    ["Float64", "number"], ["DOUBLE", "number"], ["DECIMAL(18,3)", "number"],
    ["Bool", "boolean"], ["BOOLEAN", "boolean"],
    ["Date32<DAY>", "date"], ["DATE", "date"], ["Date", "date"],
    ["Timestamp<MILLISECOND>", "datetime"], ["TIMESTAMP WITH TIME ZONE", "datetime"], ["Datetime", "datetime"],
    ["TIME", "time"], ["INTERVAL", "duration"],
    ["Utf8", "string"], ["VARCHAR", "string"], ["Categorical", "string"],
    ["List<Int32>", "array"], ["INTEGER[]", "array"], ["Struct<{a: Int32}>", "object"], ["STRUCT(a INTEGER)", "object"],
    ["Weird", undefined],
  ];
  for (const [declared, type] of cases) assert.equal(schemaType(declared), type, declared);
});

test("the cap: limit, the 10,000 ceiling and 1 MB of JSON", () => {
  const rows = Array.from({ length: 30_000 }, (_, i) => ({ i }));
  assert.equal(table(rows).resource.data.length, 1000);
  assert.equal(table(rows, { limit: 50 }).resource.data.length, 50);
  assert.equal(table(rows, { limit: 1_000_000 }).resource.data.length, MAX_LIMIT);
  const wide = Array.from({ length: 5000 }, () => ({ s: "x".repeat(900) }));
  const { resource } = table(wide, { limit: 5000 });
  assert.ok(resource.data.length < 5000 && resource.data.length > 900, String(resource.data.length));
  assert.deepEqual(resource.ganymede, { rows: 5000, shown: resource.data.length });
});

test("html: all rows up to 20, then head and tail with a count", () => {
  const small = table(Array.from({ length: 20 }, (_, i) => ({ i }))).html;
  assert.equal(small.split("<tr>").length - 1, 21);
  const big = table(Array.from({ length: 5000 }, (_, i) => ({ i })), { limit: 100 }).html;
  assert.equal(big.split("<tr>").length - 1, 1 + 10 + 1 + 5);
  assert.match(big, /… 4,985 more rows/);
  // The tail comes from the source, past the embedded rows.
  assert.match(big, /<td style="text-align:right">4999<\/td><\/tr><\/tbody>/);
  assert.match(table([{ a: "<b>" }], { title: "T&" }).html, /<caption>T&amp;<\/caption>.*&lt;b&gt;/);
});

test("a Date at midnight UTC is a date; mixed with times, a datetime", () => {
  const fields = (rows: unknown[]) => table(rows).resource.schema.fields;
  assert.equal(fields([{ d: new Date("1610-01-08") }])[0].type, "date");
  assert.equal(fields([{ d: new Date("1610-01-08") }, { d: new Date("2026-11-13T10:00:00Z") }])[0].type, "datetime");
});

test("text: shape, ranges over the embedded rows, numbered head and tail", () => {
  const rows = Array.from({ length: 52_410 }, (_, i) => ({ station: `s${i % 7}`, riders: i, day: new Date(Date.UTC(2019, 0, 1 + (i % 365))) }));
  const { text } = table(rows);
  const lines = text.split("\n");
  assert.equal(lines[0], "Table (52,410 rows, 3 columns; 1,000 shown)");
  assert.equal(lines[1], "Columns (ranges over the first 1,000 of 52,410 rows):");
  assert.match(text, /station +string +7 values/);
  assert.match(text, /riders +integer +0 to 999/);
  assert.match(text, /day +date +2019-01-01 to 2019-12-31/);
  assert.match(text, /\n  0 +\| s0 +\| 0 /);
  assert.match(text, /\n  …\n  52408 \| /);
  assert.match(text, /\n  52409 \| s0 +\| 52409/);
  assert.ok(text.length <= 4096);
  assert.match(table([{ a: null }, { a: 1 }]).text, /a +integer +1, 1 null/);
});

test("Arrow tables: fields, declared types and column access", () => {
  const cols: Record<string, unknown[]> = { id: [1n, 2n, 3n], when: [0, 86_400_000, null], name: ["a", "b", "c"] };
  const arrow = {
    schema: { fields: [{ name: "id", type: "Int64" }, { name: "when", type: "Date64<MILLISECOND>" }, { name: "name", type: "Utf8" }] },
    numRows: 3,
    getChild: (name: string) => ({ get: (i: number) => cols[name][i] }),
  };
  const { resource } = table(arrow);
  assert.deepEqual(resource.schema.fields, [
    { name: "id", type: "integer" },
    { name: "when", type: "date" },
    { name: "name", type: "string" },
  ]);
  assert.deepEqual(resource.data[1], { id: 2, when: "1970-01-02", name: "b" });
  assert.deepEqual(table(arrow, { columns: ["name"] }).resource.schema.fields.map((f) => f.name), ["name"]);
});

test("DuckDB results: names, types and row objects", () => {
  const result = {
    columnNames: () => ["moon", "radius_km", "first_seen"],
    columnTypes: () => [{ toString: () => "VARCHAR" }, { toString: () => "DOUBLE" }, { toString: () => "DATE" }],
    getRowObjectsJS: () => [{ moon: "Ganymede", radius_km: 2634.1, first_seen: new Date("1610-01-07T00:00:00Z") }],
  };
  const { resource } = table(result);
  assert.deepEqual(resource.schema.fields.map((f) => f.type), ["string", "number", "date"]);
  assert.deepEqual(resource.data[0], { moon: "Ganymede", radius_km: 2634.1, first_seen: "1610-01-07" });
});

test("Polars: slice for rows past the head", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ i }));
  const df = {
    schema: { i: { toJSON: () => ({ DataType: "Int32" }) } },
    height: rows.length,
    head: (n: number) => ({ toRecords: () => rows.slice(0, n) }),
    slice: (offset: number, length: number) => ({ toRecords: () => rows.slice(offset, offset + length) }),
    toRecords: () => rows,
  };
  const { html } = table(df, { limit: 10 });
  assert.match(html, /<td style="text-align:right">39<\/td><\/tr><\/tbody>/);
});

test("unknown values are refused", () => {
  assert.throws(() => tableSource(42), /jupyter.table takes/);
  assert.throws(() => tableSource({}), TypeError);
});
