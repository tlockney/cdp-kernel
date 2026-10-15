// With replMode or awaitPromise, the inspector holds an evaluation's result
// promise only weakly until its then-callback runs, so a GC in between fails
// the call with "Promise was collected" (#50). Calls that return a value
// without awaiting (the startup probes, flush's barrier) must not be exposed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Target, type TargetEvents } from "../src/target.ts";

const events: TargetEvents = { stream: () => {}, message: () => {}, exit: () => {} };

test("flush survives a GC between the barrier call and its microtasks", async (t) => {
  const target = await Target.launch("node", events);
  t.after(() => target.kill());
  // Each barrier() call queues a full GC ahead of the inspector's own
  // then-callback, which is the window that collected the promise.
  const setup = await target.evaluate(target.transform(`
    process.getBuiltinModule("node:v8").setFlagsFromString("--expose-gc");
    const gc = process.getBuiltinModule("node:vm").runInNewContext("gc");
    const barrier = globalThis.__cdpk.barrier;
    globalThis.__cdpk.barrier = (...args) => (queueMicrotask(gc), barrier(...args));
  `, {}));
  assert.equal(setup.exceptionDetails, undefined, JSON.stringify(setup.exceptionDetails));
  for (let i = 0; i < 3; i++) await target.flush();
});
