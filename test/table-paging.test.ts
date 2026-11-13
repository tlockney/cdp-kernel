import { test } from "node:test";
import assert from "node:assert/strict";
import { createComms } from "../runtime/comm.mjs";
import { compareEncoded, createTablePager, MAX_PAGE, PAGE_TARGET } from "../runtime/table-paging.mjs";
import { setTablePager, tableBundle, tableSource, TABLE_MIME } from "../runtime/table.mjs";

type Reply = { request?: unknown; offset?: number; total?: number; rows?: unknown[][]; error?: string };

function harness(keep?: number) {
  const sent: { msgType: string; content: Record<string, unknown> }[] = [];
  let next = 0;
  const comms = createComms((msgType, content) => {
    sent.push({ msgType, content: content as Record<string, unknown> });
  });
  const pager = createTablePager(comms.api, { keep, newId: () => `t${++next}` });
  let comm = 0;
  /** Opens a comm to the pager for `id` and returns a function that sends a request and returns the reply. */
  async function open(id: unknown) {
    const commId = `c${++comm}`;
    const handled = await comms.dispatch("comm_open", { comm_id: commId, target_name: PAGE_TARGET, data: { id } }, {}, []);
    assert.equal(handled, true);
    return async (data: Record<string, unknown>): Promise<Reply> => {
      const before = sent.length;
      await comms.dispatch("comm_msg", { comm_id: commId, data }, {}, []);
      assert.equal(sent.length, before + 1);
      return (sent.at(-1)!.content.data ?? {}) as Reply;
    };
  }
  return { sent, pager, open };
}

const rows = Array.from({ length: 2500 }, (_, i) => ({ n: i, name: `row ${i}`, odd: i % 2 === 1 ? i : null }));

function bundle(value: unknown, pager: ReturnType<typeof createTablePager> | null, options: { limit?: number } = {}) {
  const b = tableBundle(tableSource(value), { ...options, pager });
  return b[TABLE_MIME] as { data: unknown[]; ganymede: { rows: number; shown: number; page?: string } };
}

test("a table cut by the cap names its page id; one that fits doesn't", () => {
  const { pager } = harness();
  assert.equal(bundle(rows, pager).ganymede.page, "t1");
  assert.equal(bundle(rows.slice(0, 10), pager).ganymede.page, undefined);
  assert.equal(bundle(rows, null).ganymede.page, undefined);
  assert.equal(pager.size(), 1);
});

test("pages past the embedded rows, encoded as the output's are", async () => {
  const { pager, open } = harness();
  const resource = bundle(rows, pager);
  assert.equal(resource.data.length, 1000);
  const ask = await open(resource.ganymede.page);
  const reply = await ask({ request: 1, offset: 2450, limit: 100 });
  assert.equal(reply.request, 1);
  assert.equal(reply.offset, 2450);
  assert.equal(reply.total, 2500);
  assert.equal(reply.rows!.length, 50);
  assert.deepEqual(reply.rows![0], [2450, "row 2450", null]);
  // At most MAX_PAGE rows a request.
  assert.equal((await ask({ request: 2, offset: 0, limit: 5000 })).rows!.length, MAX_PAGE);
});

test("sorts the whole table in the kernel, nulls last either way", async () => {
  const { pager, open } = harness();
  const ask = await open(bundle(rows, pager).ganymede.page);
  const down = await ask({ request: 1, offset: 0, limit: 3, sort: { column: "n", descending: true } });
  assert.deepEqual(down.rows!.map((r) => r[0]), [2499, 2498, 2497]);
  const odd = await ask({ request: 2, offset: 1248, limit: 4, sort: { column: "odd", descending: false } });
  // 1,250 odd numbers, then 1,250 nulls.
  assert.deepEqual(odd.rows!.map((r) => r[2]), [2497, 2499, null, null]);
  const names = await ask({ request: 3, offset: 0, limit: 3, sort: { column: "name" } });
  // Numeric collation: "row 2" before "row 10".
  assert.deepEqual(names.rows!.map((r) => r[1]), ["row 0", "row 1", "row 2"]);
});

test("bad requests get an error with their request id", async () => {
  const { pager, open } = harness();
  const ask = await open(bundle(rows, pager).ganymede.page);
  assert.match((await ask({ request: 7, offset: -1, limit: 10 })).error!, /whole numbers/);
  const missing = await ask({ request: 8, offset: 0, limit: 10, sort: { column: "nope" } });
  assert.equal(missing.request, 8);
  assert.match(missing.error!, /no column "nope"/);
});

test("an unknown or evicted table gets an error and the comm closes", async () => {
  const { pager, sent, open } = harness(2);
  const first = bundle(rows, pager).ganymede.page;
  bundle(rows, pager);
  bundle(rows, pager);
  assert.equal(pager.size(), 2);
  await open(first);
  assert.equal(sent.at(-2)!.msgType, "comm_msg");
  assert.match(String((sent.at(-2)!.content.data as Reply).error), /no longer has this table/);
  assert.equal(sent.at(-1)!.msgType, "comm_close");
});

test("integers past 2^53 compare exactly; NaN sorts last in a numeric column", () => {
  assert.ok(compareEncoded("9007199254740993", "9007199254740992", "integer") > 0);
  assert.ok(compareEncoded("NaN", 1, "number") > 0);
  assert.ok(compareEncoded("NaN", 1, "number", true) > 0);
  assert.ok(compareEncoded(true, false, "boolean") > 0);
});

test("the jupyter namespace's tables page by default", async () => {
  const { pager } = harness();
  setTablePager(pager);
  try {
    const b = tableBundle(tableSource(rows));
    assert.equal((b[TABLE_MIME] as { ganymede: { page?: string } }).ganymede.page, "t1");
  } finally {
    setTablePager(null);
  }
});
