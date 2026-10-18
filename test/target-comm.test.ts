// Frontend comm messages reach a Node or Deno target over its stdin (#287):
// as CDP call arguments, V8 kept each message's source in its compilation
// cache, so the data of every message stayed in the target's memory.
import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import { Target, type TargetEvents } from "../src/target.ts";
import { loadTypeStripper } from "../src/transform.ts";

await loadTypeStripper("esbuild");

const events: TargetEvents = { stream: () => {}, message: () => {}, exit: () => {} };

async function launch(t: TestContext) {
  const target = await Target.launch("node", events);
  t.after(() => target.kill());
  const run = async (code: string) => {
    const res = await target.evaluate(target.transform(code, {}));
    assert.equal(res.exceptionDetails, undefined, JSON.stringify(res.exceptionDetails));
    return res.result.value;
  };
  await run(`
    process.getBuiltinModule("node:v8").setFlagsFromString("--expose-gc");
    globalThis.gc = process.getBuiltinModule("node:vm").runInNewContext("gc");
    globalThis.got = [];
    jupyter.comm.registerTarget("t", (comm) => comm.onMsg((m) => {
      got.push({ data: m.data, buffers: m.buffers.map((b) => [...b]) });
    }));
  `);
  await target.dispatchComm("comm_open", { comm_id: "c1", target_name: "t", data: {} }, {}, []);
  return { target, run };
}

test("comm messages arrive whole and in order", async (t) => {
  const { target, run } = await launch(t);
  const texts = ["plain", "é ✓ 🎉", "line\nbreak", "x".repeat(200_000)];
  for (const [i, text] of texts.entries()) {
    assert.deepEqual(
      await target.dispatchComm("comm_msg", { comm_id: "c1", data: { i, text } }, { m: i }, [new Uint8Array([i, 255])]),
      { handled: true },
    );
  }
  const got = await run("JSON.stringify(got)");
  assert.deepEqual(JSON.parse(String(got)), texts.map((text, i) => ({ data: { i, text }, buffers: [[i, 255]] })));
});

test("a comm message's data is not kept once handled", async (t) => {
  const { target, run } = await launch(t);
  await run("got = null; jupyter.comm.registerTarget('t', (comm) => comm.onMsg(() => {}));");
  await target.dispatchComm("comm_open", { comm_id: "c2", target_name: "t", data: {} }, {}, []);
  const heap = async () => Number(await run("gc(); gc(); process.memoryUsage().heapUsed"));
  const before = await heap();
  // 100 distinct 128 KiB strings: 12.5 MiB if kept.
  for (let i = 0; i < 100; i++) {
    await target.dispatchComm("comm_msg", { comm_id: "c2", data: { pad: String(i).padStart(131072, "y") } }, {}, []);
  }
  const grew = (await heap()) - before;
  assert.ok(grew < 4 * 2 ** 20, `heap grew by ${(grew / 2 ** 20).toFixed(1)} MiB`);
});
