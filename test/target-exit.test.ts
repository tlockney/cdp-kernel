// process.exit() or Deno.exit() in a cell ends the target, so the kernel
// starts a fresh one (#130). With an inspector client attached, both
// runtimes would otherwise wait forever for it to disconnect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Target, type TargetEvents } from "../src/target.ts";
import { loadTypeStripper } from "../src/transform.ts";

await loadTypeStripper("esbuild");

const hasDeno = spawnSync("deno", ["--version"]).status === 0;

const cases = [
  { runtime: "node", cell: "process.exit(3)", denoCompat: false },
  { runtime: "deno", cell: "Deno.exit(3)", denoCompat: false },
  { runtime: "node", cell: "Deno.exit(3)", denoCompat: true },
] as const;

for (const { runtime, cell, denoCompat } of cases) {
  test(`${cell} in a cell ends a ${runtime}${denoCompat ? " --deno-compat" : ""} target with its exit code`, {
    skip: runtime === "deno" && !hasDeno ? "deno not on PATH" : false,
  }, async (t) => {
    let exited: (code: number | null) => void;
    const exit = new Promise<number | null>((resolve) => (exited = resolve));
    const events: TargetEvents = { stream: () => {}, message: () => {}, exit: (code) => exited(code) };
    const target = await Target.launch(runtime, events, { denoCompat });
    t.after(() => target.kill());
    await assert.rejects(target.evaluate(target.transform(cell, {})), new RegExp(`^Error: ${runtime} exited$`));
    const code = await Promise.race([exit, new Promise((r) => setTimeout(() => r("timeout"), 5000))]);
    assert.equal(code, 3);
  });
}
