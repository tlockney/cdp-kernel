// The inspector keeps every object it hands out a remote reference to alive
// until that reference is released, so without releasing them a long
// session keeps every cell's result (#286).
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
    return res.result;
  };
  await run(`
    process.getBuiltinModule("node:v8").setFlagsFromString("--expose-gc");
    globalThis.gc = process.getBuiltinModule("node:vm").runInNewContext("gc");
  `);
  // Collected once a later cell's GC has run: a WeakRef keeps its target
  // until the end of the job that made it.
  const collected = async (ref: string) => {
    await run("gc(); gc();");
    return (await run(`${ref}.deref() === undefined`)).value;
  };
  return { target, run, collected };
}

test("a cell's result is collected once released", async (t) => {
  const { target, run, collected } = await launch(t);
  const result = await run("(() => { const o = { big: new Uint8Array(1024) }; globalThis.ref = new WeakRef(o); return o; })()");
  assert.ok(result.objectId);
  await target.releaseResults();
  assert.equal(await collected("ref"), true);
});

test("a cell's thrown error is collected once released", async (t) => {
  const { target, run, collected } = await launch(t);
  const res = await target.evaluate(target.transform("globalThis.ref = new WeakRef(new Error('x')); throw ref.deref();", {}));
  assert.ok(res.exceptionDetails?.exception?.objectId);
  await target.releaseResults();
  assert.equal(await collected("ref"), true);
});
