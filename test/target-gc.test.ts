// With replMode or awaitPromise, the inspector holds an evaluation's result
// promise only weakly until its then-callback runs, so a GC in between fails
// the call with "Promise was collected" (#50, #55). Each test queues a full
// GC just before that callback.
import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import { Target, type TargetEvents } from "../src/target.ts";

const events: TargetEvents = { stream: () => {}, message: () => {}, exit: () => {} };

async function launch(t: TestContext) {
  const target = await Target.launch("node", events);
  t.after(() => target.kill());
  const run = async (code: string) => {
    const res = await target.evaluate(target.transform(code, {}));
    assert.equal(res.exceptionDetails, undefined, JSON.stringify(res.exceptionDetails));
  };
  await run(`
    process.getBuiltinModule("node:v8").setFlagsFromString("--expose-gc");
    globalThis.gc = process.getBuiltinModule("node:vm").runInNewContext("gc");
  `);
  return { target, run };
}

test("flush survives a GC between the barrier call and its microtasks", async (t) => {
  const { target, run } = await launch(t);
  const original = "globalThis.__cdpk.barrier";
  await run(`const barrier = ${original}; ${original} = (...args) => (queueMicrotask(gc), barrier(...args));`);
  for (let i = 0; i < 3; i++) await target.flush();
});

test("a cell's value survives a GC queued as it finishes", async (t) => {
  const { target } = await launch(t);
  for (let i = 0; i < 3; i++) {
    const res = await target.evaluate(target.transform(`queueMicrotask(gc); ${i}`, {}));
    assert.equal(res.result.value, i);
  }
});

test("inspect survives a GC queued by describeForInspect", async (t) => {
  const { target, run } = await launch(t);
  const original = "globalThis.__cdpk.describeForInspect";
  await run(`const describe = ${original}; ${original} = (...args) => (queueMicrotask(gc), describe(...args)); var answer = 42;`);
  assert.match(String(await target.inspect("answer", 0)), /42/);
});

test("broadcastResult survives a GC queued as it settles", async (t) => {
  const { target, run } = await launch(t);
  const original = "globalThis.__cdpk.broadcastResult";
  await run(`const broadcast = ${original}; ${original} = async (...args) => { await broadcast(...args); queueMicrotask(gc); };`);
  await target.broadcastResult(1, { type: "number", value: 5, description: "5" });
});

test("dispatchComm survives a GC queued as it settles", async (t) => {
  const { target, run } = await launch(t);
  const original = "globalThis.__cdpk.commDispatch";
  await run(`const dispatch = ${original}; ${original} = async (...args) => { const r = await dispatch(...args); queueMicrotask(gc); return r; };`);
  assert.deepEqual(await target.dispatchComm("comm_msg", { comm_id: "none", data: {} }, {}, []), { handled: false });
});
