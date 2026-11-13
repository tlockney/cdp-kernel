import { test } from "node:test";
import assert from "node:assert/strict";
import { compose, createSql, decimalValue, inlineParams, quoteIdent, quoteString, rowsAsJson, SqlResult, timeText, toParam, uniqueNames, type SqlEngine } from "../runtime/sql.mjs";
import { TABLE_MIME } from "../runtime/table.mjs";

function fake(rows: Record<string, unknown>[] = [{ n: 1 }]) {
  const calls: { text: string; params: unknown[] }[] = [];
  let opened = 0;
  let closed = 0;
  let interrupted = 0;
  let release: (() => void) | undefined;
  const engine: SqlEngine = {
    connection: { fake: true },
    interrupt: () => {
      interrupted++;
      release?.();
    },
    async query(text, params) {
      calls.push({ text, params });
      if (text === "slow") await new Promise<void>((resolve) => (release = resolve));
      return new SqlResult([{ name: "n", type: "BIGINT" }], rows);
    },
    async close() {
      closed++;
    },
  };
  const state = { calls, opened: () => opened, closed: () => closed, interrupted: () => interrupted };
  const openEngine = async () => {
    opened++;
    return engine;
  };
  return { state, openEngine };
}

test("the tag binds every value as a parameter", () => {
  const strings = Object.assign(["select * from t where a = ", " and b = ", ""], { raw: [] });
  assert.deepEqual(compose(strings, [1, "x' or 1=1"]), {
    text: "select * from t where a = ? and b = ?",
    params: [1, "x' or 1=1"],
  });
});

test("toParam: dates as ISO strings, objects as JSON, undefined as null", () => {
  assert.equal(toParam(new Date(0)), "1970-01-01T00:00:00.000Z");
  assert.equal(toParam({ a: [1] }), '{"a":[1]}');
  assert.equal(toParam(undefined), null);
  assert.equal(toParam(2n ** 60n), 2n ** 60n);
});

test("inlineParams: literals for ? outside strings, names and comments", () => {
  assert.equal(
    inlineParams(`select '?', "a?", ? -- why?\n, ? /* ? */ , ?, ?, ?, ?, ?, ?`, [1, "it's", null, true, 1.5, 2n ** 70n, Number.NaN, new Uint8Array([97, 255])]),
    `select '?', "a?", 1 -- why?\n, 'it''s' /* ? */ , NULL, TRUE, 1.5::DOUBLE, 1180591620717411303424, 'NaN'::DOUBLE, '\\x61\\xff'::BLOB`,
  );
  assert.equal(inlineParams("select 'it''s ?', ?", [2]), "select 'it''s ?', 2");
  assert.equal(inlineParams("select 'a'?", ["x"]), "select 'a' 'x'");
  assert.equal(inlineParams("select 1-?, 1-?, 1-?", [-1, -1.5, -(2n ** 70n)]), "select 1-(-1), 1-(-1.5::DOUBLE), 1-(-1180591620717411303424)");
  assert.throws(() => inlineParams("select ?", [1, 2]), RangeError);
  assert.throws(() => inlineParams("select ?, ?", [1]), RangeError);
});

test("quoting identifiers and strings", () => {
  assert.equal(quoteIdent('a"b'), '"a""b"');
  assert.equal(quoteString("it's"), "'it''s'");
});

test("jupyter.sql runs on one engine, opened on the first query", async () => {
  const { state, openEngine } = fake();
  const sql = createSql({ importModule: () => Promise.reject(new Error("unused")), openEngine });
  const t = "moons";
  const result = await sql`select * from ${sql.raw(t)} where r > ${2000}`;
  await sql.query("select ?", [new Date(0)]);
  assert.equal(state.opened(), 1);
  assert.deepEqual(state.calls, [
    { text: "select * from moons where r > ?", params: [2000] },
    { text: "select ?", params: ["1970-01-01T00:00:00.000Z"] },
  ]);
  assert.deepEqual(result.rows, [{ n: 1 }]);
  assert.deepEqual(await sql.connection(), { fake: true });
  await sql.close();
  assert.equal(state.closed(), 1);
  await sql`select 1`;
  assert.equal(state.opened(), 2);
});

test("jupyter.sql refuses a plain call", async () => {
  const { openEngine } = fake();
  const sql = createSql({ importModule: () => Promise.reject(new Error("unused")), openEngine });
  await assert.rejects((sql as unknown as (s: string) => Promise<unknown>)("select 1"), /is a tag/);
  await assert.rejects(sql.query(42 as unknown as string), TypeError);
});

test("an engine that fails to open is retried on the next query", async () => {
  let attempts = 0;
  const sql = createSql({
    importModule: () => Promise.reject(new Error("unused")),
    openEngine: async () => {
      attempts++;
      if (attempts === 1) throw new Error("no network");
      return fake().openEngine();
    },
  });
  await assert.rejects(sql`select 1`, /no network/);
  await sql`select 1`;
  assert.equal(attempts, 2);
});

test("an abort of the signal interrupts the running query", async () => {
  const { state, openEngine } = fake();
  const controller = new AbortController();
  const sql = createSql({ importModule: () => Promise.reject(new Error("unused")), openEngine, signal: () => controller.signal });
  const running = sql.query("slow");
  await new Promise((r) => setTimeout(r, 10));
  controller.abort();
  await running;
  assert.equal(state.interrupted(), 1);
  await assert.rejects(sql`select 1`, (err: unknown) => (err as Error).name === "AbortError");
});

test("load: a file path is quoted into the query, rows go in as JSON", async () => {
  const { state, openEngine } = fake();
  const sql = createSql({ importModule: () => Promise.reject(new Error("unused")), openEngine });
  await sql.load("w x", "data/it's.csv");
  await sql.load("moons", [{ moon: "Io", r: 1821.6, d: new Date("1610-01-08T10:00:00Z"), day: new Date("1610-01-08"), n: 1, tags: ["a"] }]);
  assert.equal(state.calls[0].text, `create or replace table "w x" as select * from 'data/it''s.csv'`);
  assert.equal(state.calls[1].text, `create or replace table "moons" as select unnest(from_json(?, ?), recursive := true)`);
  assert.deepEqual(JSON.parse(state.calls[1].params[1] as string), [
    { moon: "VARCHAR", r: "DOUBLE", d: "TIMESTAMP", day: "DATE", n: "BIGINT", tags: "JSON" },
  ]);
  assert.deepEqual(JSON.parse(state.calls[1].params[0] as string), [
    { moon: "Io", r: 1821.6, d: "1610-01-08T10:00:00.000Z", day: "1610-01-08", n: 1, tags: ["a"] },
  ]);
  await assert.rejects(sql.load("", []), TypeError);
  await assert.rejects(sql.load("e", []), /no columns/);
});

test("rowsAsJson: load keeps whole values, with bytes as base64", () => {
  const long = "x".repeat(5000);
  const { json } = rowsAsJson([{ s: long, b: new Uint8Array([97, 98]), nested: { at: new Date("2020-01-02T03:04:05Z"), big: 2n ** 70n } }]);
  assert.deepEqual(JSON.parse(json), [{ s: long, b: "YWI=", nested: { at: "2020-01-02T03:04:05.000Z", big: "1180591620717411303424" } }]);
  const deep: Record<string, unknown> = {};
  let at = deep;
  for (let i = 0; i < 100; i++) at = (at.next = {}) as Record<string, unknown>;
  assert.throws(() => rowsAsJson([{ deep }]), TypeError);
});

test("timeText: TIME values in their declared unit", () => {
  assert.equal(timeText(36672500000n), "10:11:12.5");
  assert.equal(timeText(36672000, "Time<MILLISECOND>"), "10:11:12");
  assert.equal(timeText(0), "00:00:00");
});

test("uniqueNames: repeated column names get a suffix", () => {
  assert.deepEqual(uniqueNames(["id", "id", "x", "id", "id_1"]), ["id", "id_1", "x", "id_2", "id_1_1"]);
});

test("rowsAsJson: non-finite numbers become null", () => {
  const { json } = rowsAsJson([{ x: 1.5 }, { x: Number.NaN }]);
  assert.deepEqual(JSON.parse(json), [{ x: 1.5 }, { x: null }]);
});

test("a SqlResult shows as a table with DuckDB's types", () => {
  const result = new SqlResult([{ name: "d", type: "DATE" }, { name: "n", type: "BIGINT" }], [{ d: new Date("2020-01-02T00:00:00Z"), n: 3 }]);
  const out = (result as unknown as Record<symbol, () => Record<string, unknown>>)[Symbol.for("Jupyter.display")]();
  const resource = out[TABLE_MIME] as { schema: { fields: { type: string }[] }; data: unknown[] };
  assert.deepEqual(resource.schema.fields.map((f) => f.type), ["date", "integer"]);
  assert.deepEqual(resource.data, [{ d: "2020-01-02", n: 3 }]);
});

test("decimalValue: Arrow's 128-bit words, signed and scaled", () => {
  assert.equal(decimalValue(new Uint32Array([26341, 0, 0, 0]), 1), 2634.1);
  assert.equal(decimalValue(new Uint32Array([0xeb1f0ad2, 0xab54a98c, 0, 0]), 0), 12345678901234567890n);
  assert.equal(decimalValue(new Uint32Array([0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff]), 2), -0.01);
  assert.equal(decimalValue(125, 2), 1.25);
});
