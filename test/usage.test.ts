// usage_request (#409): the kernel's memory and CPU are the host process's
// plus the target's, measured from the OS where it can.
import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { Target, type TargetEvents } from "../src/target.ts";
import type { KernelTarget } from "../src/target-api.ts";
import { loadTypeStripper } from "../src/transform.ts";
import { parseCpuTime, processUsage, UsageMeter } from "../src/usage.ts";
import { KernelCore } from "../src/kernel-core.ts";
import type { JsonObject } from "../src/message.ts";
import { FakeChannels } from "./fake-channels.ts";

await loadTypeStripper("esbuild");

const hasDeno = spawnSync("deno", ["--version"]).status === 0;
/** Where the OS reports a process's memory and CPU time. */
const measurable = process.platform === "linux" || process.platform === "darwin";
const events: TargetEvents = { stream: () => {}, message: () => {}, exit: () => {} };

test("parseCpuTime reads ps's time column", () => {
  assert.equal(parseCpuTime("0:01.25"), 1.25);
  assert.equal(parseCpuTime("12:03"), 723);
  assert.equal(parseCpuTime("01:02:03"), 3723);
  assert.equal(parseCpuTime("2-01:00:00"), 2 * 86_400 + 3_600);
  assert.equal(parseCpuTime("-"), null);
});

test("processUsage reads this process's memory and CPU time", { skip: !measurable }, async () => {
  const usage = await processUsage(process.pid);
  assert.ok(usage.memory !== undefined && usage.memory > 1 << 20, JSON.stringify(usage));
  assert.ok(usage.cpuTime !== undefined && usage.cpuTime > 0, JSON.stringify(usage));
});

test("processUsage leaves out a process that is gone", async () => {
  const done = spawnSync(process.execPath, ["-e", "0"]);
  assert.deepEqual(await processUsage(done.pid ?? 0), {});
});

test("with no target running the reply covers the host alone", async () => {
  const reply = await new UsageMeter().reply(null);
  assert.equal(reply.pid, process.pid);
  assert.equal(typeof reply.hostname, "string");
  assert.equal(typeof reply.kernel_cpu, "number");
  assert.ok(typeof reply.kernel_memory === "number" && reply.kernel_memory > 0, JSON.stringify(reply));
  assert.equal(typeof reply.cpu_count, "number");
  assert.equal(typeof (reply.host_virtual_memory as { total?: unknown }).total, "number");
});

test("a target that can't measure itself leaves the kernel's figures out", async () => {
  const unmeasured = {} as KernelTarget;
  const reply = await new UsageMeter().reply(unmeasured);
  assert.equal("kernel_cpu" in reply, false);
  assert.equal("kernel_memory" in reply, false);
  assert.equal(reply.pid, process.pid);
});

test("a target's memory and CPU are added to the host's", async () => {
  const startedAt = Date.now() - 1000;
  const target = { usage: async () => ({ memory: 1e12, cpuTime: 1_000_000, startedAt }) } as unknown as KernelTarget;
  const reply = await new UsageMeter().reply(target);
  assert.ok((reply.kernel_memory as number) > 1e12, JSON.stringify(reply));
  // One second of CPU in about one second since it started.
  assert.ok((reply.kernel_cpu as number) >= 50, JSON.stringify(reply));
});

test("a missed sample keeps the previous CPU baseline", async () => {
  // A target an hour old, idle until now.
  const startedAt = Date.now() - 3_600_000;
  let sample: { cpuTime?: number; memory?: number } = { cpuTime: 0, memory: 1 };
  const target = { usage: async () => ({ ...sample, startedAt }) } as unknown as KernelTarget;
  const meter = new UsageMeter();
  await meter.reply(target);
  sample = { memory: 1 };
  assert.equal("kernel_cpu" in await meter.reply(target), false);
  // Then busy: half a second of CPU in the last half second or so.
  await new Promise((r) => setTimeout(r, 500));
  sample = { cpuTime: 500_000, memory: 1 };
  const reply = await meter.reply(target);
  assert.ok((reply.kernel_cpu as number) >= 50, JSON.stringify(reply));
});

test("a restarted target's CPU counts from its own start", async () => {
  const meter = new UsageMeter();
  const old = { usage: async () => ({ cpuTime: 100_000_000, startedAt: Date.now() - 200_000 }) } as unknown as KernelTarget;
  await meter.reply(old);
  // Long enough that the host's own share of the next interval is small.
  await new Promise((r) => setTimeout(r, 500));
  // A new target: its CPU time isn't measured against the old one's.
  const startedAt = Date.now() - 1000;
  const fresh = { usage: async () => ({ cpuTime: 0, startedAt }) } as unknown as KernelTarget;
  const reply = await meter.reply(fresh);
  assert.ok((reply.kernel_cpu as number) < 50, JSON.stringify(reply));
});

test("an interrupt doesn't wait behind a slow usage_request", async () => {
  const channels = new FakeChannels();
  let measured!: (content: JsonObject) => void;
  const core = new KernelCore({
    runtime: "node",
    version: "0",
    channels,
    launchTarget: () => new Promise<KernelTarget>(() => {}),
    usage: () => new Promise<JsonObject>((resolve) => (measured = resolve)),
    log: () => {},
    exit: () => {},
  });
  void core.run();
  channels.push("control", "usage_request");
  channels.push("control", "interrupt_request");
  assert.equal((await channels.replyOf("interrupt_reply")).content.status, "ok");
  measured({ pid: 1 });
  assert.deepEqual((await channels.replyOf("usage_reply")).content, { pid: 1 });
});

test("a host that can't measure usage still answers usage_request", async () => {
  const channels = new FakeChannels();
  const core = new KernelCore({
    runtime: "browser",
    version: "0",
    channels,
    launchTarget: () => new Promise<KernelTarget>(() => {}),
    log: () => {},
    exit: () => {},
  });
  void core.run();
  channels.push("control", "usage_request");
  assert.deepEqual((await channels.replyOf("usage_reply")).content, {});
});

for (const runtime of ["node", "deno"] as const) {
  const skip = !measurable ? "no process usage on this OS" : runtime === "deno" && !hasDeno ? "deno not on PATH" : false;

  async function launch(t: TestContext) {
    const target = await Target.launch(runtime, events);
    t.after(() => target.kill());
    const run = async (code: string) => {
      const res = await target.evaluate(target.transform(code, {}));
      assert.equal(res.exceptionDetails, undefined, JSON.stringify(res.exceptionDetails));
    };
    return { target, run };
  }

  test(`a ${runtime} target's memory counts what its cells hold outside the JS heap`, { skip }, async (t) => {
    const { target, run } = await launch(t);
    const before = await target.usage();
    assert.ok(before.memory !== undefined && before.cpuTime !== undefined, JSON.stringify(before));
    // 256 MiB of typed array memory, touched so it is resident.
    await run("globalThis.big = new Uint8Array(256 * 1024 * 1024).fill(1)");
    const after = await target.usage();
    assert.ok(after.memory! - before.memory! > 200 * 1024 * 1024, `${before.memory} -> ${after.memory}`);
  });

  test(`a ${runtime} target's busy cell shows as kernel CPU, and usage answers while it runs`, { skip }, async (t) => {
    const { target } = await launch(t);
    const meter = new UsageMeter();
    await meter.reply(target);
    const cell = target.evaluate(target.transform("{ const end = Date.now() + 1500; while (Date.now() < end); }", {}));
    await new Promise((r) => setTimeout(r, 1000));
    const started = Date.now();
    const reply = await meter.reply(target);
    assert.ok(Date.now() - started < 1000, `usage took ${Date.now() - started} ms during a busy cell`);
    assert.ok((reply.kernel_cpu as number) >= 50, JSON.stringify(reply));
    await cell;
  });
}
