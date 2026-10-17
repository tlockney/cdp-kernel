// A request sent after the target is gone must fail rather than wait for a
// reply that can't come (#133).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BunTarget } from "../src/bun-target.ts";
import { Target, type TargetEvents } from "../src/target.ts";
import { WorkerdTarget } from "../src/workerd-target.ts";
import { hasBun } from "./bun.ts";
import { loadTypeStripper } from "../src/transform.ts";

await loadTypeStripper("esbuild");

const WORKERD = join(fileURLToPath(new URL("../", import.meta.url)), "node_modules", ".bin", "workerd");

const launchers = {
  node: { launch: (events: TargetEvents) => Target.launch("node", events), skip: false },
  bun: { launch: (events: TargetEvents) => BunTarget.launch(events), skip: !hasBun() },
  workerd: {
    launch: (events: TargetEvents) => WorkerdTarget.launch(events, { executable: WORKERD }),
    skip: !existsSync(WORKERD) || process.platform === "win32",
  },
};

function settles(promise: Promise<unknown>, ms = 5_000): Promise<"resolved" | "rejected" | "pending"> {
  return Promise.race([
    promise.then(() => "resolved" as const, () => "rejected" as const),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms)),
  ]);
}

for (const [runtime, { launch, skip }] of Object.entries(launchers)) {
  test(`${runtime}: requests after the target exits are rejected`, { skip }, async (t) => {
    const exited = Promise.withResolvers<void>();
    const target = await launch({ stream: () => {}, message: () => {}, exit: () => exited.resolve() });
    t.after(() => target.kill());
    target.kill();
    await exited.promise;
    assert.equal(await settles(target.evaluate(target.transform("1", {}))), "rejected");
    // workerd has no barrier to wait for, so its flush() resolves.
    assert.notEqual(await settles(target.flush()), "pending");
  });
}
