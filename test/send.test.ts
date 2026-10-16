// A display payload JSON.stringify rejects must throw into the cell without
// leaving a gated barrier marker the host waits on forever (#129).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BunTarget } from "../src/bun-target.ts";
import { Target, type TargetEvents, type TargetMessage } from "../src/target.ts";
import { hasBun } from "./bun.ts";

function within<T>(promise: Promise<T>, what: string, ms = 10_000): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} didn't settle within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const launchers = {
  node: (events: TargetEvents) => Target.launch("node", events),
  bun: (events: TargetEvents) => BunTarget.launch(events),
};

for (const [runtime, launch] of Object.entries(launchers)) {
  test(`${runtime}: an unserializable broadcast throws into the cell and later cells run`, { skip: runtime === "bun" && !hasBun() }, async (t) => {
    const messages: TargetMessage[] = [];
    const target = await launch({ stream: () => {}, message: (m) => void messages.push(m), exit: () => {} });
    t.after(() => target.kill());

    const failed = await target.evaluate(target.transform(`jupyter.broadcast("x", { n: 1n })`, {}));
    assert.notEqual(failed.exceptionDetails, undefined);
    await within(target.flush(), "flush");

    const res = await within(target.evaluate(target.transform(`jupyter.broadcast("y", { n: 1 }); 7`, {})), "next cell");
    assert.equal(res.exceptionDetails, undefined, JSON.stringify(res.exceptionDetails));
    await within(target.flush(), "flush");
    assert.deepEqual(messages.filter((m) => m.kind === "iopub").map((m) => m.msg_type), ["y"]);
  });
}
