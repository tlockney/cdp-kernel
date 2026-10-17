// An interrupt that lands while a cell's result is being formatted must not
// surface as a KernelError (#135).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { BunTarget } from "../src/bun-target.ts";
import { Interrupted, Target, type TargetEvents } from "../src/target.ts";
import { hasBun } from "./bun.ts";
import { loadTypeStripper } from "../src/transform.ts";

await loadTypeStripper("esbuild");

const events: TargetEvents = { stream: () => {}, message: () => {}, exit: () => {} };
const SLOW_DISPLAY = `({ [Symbol.for("Jupyter.display")]: async () => {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return { "text/plain": "slow" };
} })`;

async function startSlowBroadcast(target: Target | BunTarget) {
  const res = await target.evaluate(target.transform(SLOW_DISPLAY, {}));
  assert.equal(res.exceptionDetails, undefined, JSON.stringify(res.exceptionDetails));
  const broadcast = target.broadcastResult(1, res.result);
  broadcast.catch(() => {});
  await sleep(300);
  await target.interrupt();
  return broadcast;
}

test("node: interrupting an async $display rejects broadcastResult with Interrupted", async (t) => {
  const target = await Target.launch("node", events);
  t.after(() => target.kill());
  await assert.rejects(startSlowBroadcast(target), Interrupted);
  await target.flush();
});

test("bun: interrupting an async $display leaves broadcastResult to finish", { skip: !hasBun() }, async (t) => {
  const target = await BunTarget.launch(events);
  t.after(() => target.kill());
  await startSlowBroadcast(target);
  await target.flush();
});
