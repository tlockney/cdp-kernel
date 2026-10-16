// prompt() blocks the target's main thread on stdin, so output written
// before it must already be in the pipe; otherwise the input_request's
// barrier marker never reaches the host and nobody answers (#131).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BunTarget } from "../src/bun-target.ts";
import { Target, type TargetEvents, type TargetMessage } from "../src/target.ts";
import { hasBun } from "./bun.ts";

const launchers = {
  node: (events: TargetEvents) => Target.launch("node", events),
  bun: (events: TargetEvents) => BunTarget.launch(events),
};

for (const [runtime, launch] of Object.entries(launchers)) {
  test(`${runtime}: prompt() after a write larger than the pipe buffer gets its reply`, { skip: runtime === "bun" && !hasBun() }, async (t) => {
    let stdout = 0;
    const asked = Promise.withResolvers<void>();
    const onMessage = (m: TargetMessage) => {
      if (m.kind === "input_request") asked.resolve();
    };
    const target = await launch({ stream: (_, text) => void (stdout += text.length), message: onMessage, exit: () => {} });
    t.after(() => target.kill());

    const result = target.evaluate(target.transform(`console.log("x".repeat(300_000)); prompt("Name?")`, {}));
    const timer = setTimeout(() => asked.reject(new Error(`no input_request; ${stdout} stdout chars arrived`)), 10_000);
    await asked.promise.finally(() => clearTimeout(timer));
    target.replyInput("Ada");
    const res = await result;
    assert.equal(res.exceptionDetails, undefined, JSON.stringify(res.exceptionDetails));
    await target.flush();
    assert.ok(stdout >= 300_000, `${stdout} stdout chars`);
  });
}
