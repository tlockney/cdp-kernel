// jupyter.signal (#418): an interrupt aborts it, so a cell waiting on
// something the interrupt can't reach, such as a comm reply, can stop. Each
// cell, and each comm handler that starts while no cell runs, gets its own
// (#421). test/browser.test.ts covers the browser target.
import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJupyter } from "../runtime/display.mjs";
import { createHandler, type EvaluatorShim } from "../runtime/evaluator.mjs";
import { BunTarget } from "../src/bun-target.ts";
import { Interrupted, Target } from "../src/target.ts";
import type { KernelTarget, TargetEvents } from "../src/target-api.ts";
import { loadTypeStripper } from "../src/transform.ts";
import { WorkerdTarget } from "../src/workerd-target.ts";
import { hasBun } from "./bun.ts";

await loadTypeStripper("esbuild");

const hasDeno = spawnSync("deno", ["--version"]).status === 0;
const WORKERD = join(fileURLToPath(new URL("../", import.meta.url)), "node_modules", ".bin", "workerd");

function jupyter() {
  return createJupyter({ inspect: String, base64: () => "", readFile: () => new Uint8Array(), send: () => {}, input: () => null });
}

test("each cell gets its own signal, and an interrupt aborts only the running cell's", () => {
  const j = jupyter();
  j.startCell();
  const first = j.namespace.signal;
  j.startCell();
  const second = j.namespace.signal;
  assert.notEqual(first, second);
  j.abortSignal();
  assert.ok(second.aborted);
  assert.equal(second.reason.name, "AbortError");
  assert.equal(second.reason.message, "Execution interrupted");
  assert.ok(!first.aborted, "a finished cell's signal");
  j.startCell();
  assert.ok(!j.namespace.signal.aborted);
});

test("a comm handler with no cell running gets its own signal; one during a cell shares the cell's", async () => {
  const j = jupyter();
  const seen: AbortSignal[] = [];
  let release = () => {};
  j.namespace.comm.registerTarget("t", async () => {
    seen.push(j.namespace.signal);
    await new Promise<void>((resolve) => (release = resolve));
  });
  j.startCell();
  const cell = j.namespace.signal;
  j.abortSignal();
  // Between cells, after that interrupt: a fresh signal, which an interrupt aborts.
  const own = j.commDispatch("comm_open", { comm_id: "a", target_name: "t" }, {}, [], true);
  await Promise.resolve();
  assert.notEqual(seen[0], cell);
  assert.ok(!seen[0].aborted);
  j.abortSignal();
  assert.ok(seen[0].aborted);
  release();
  await own;
  // During a cell: the cell's.
  j.startCell();
  const shared = j.commDispatch("comm_open", { comm_id: "b", target_name: "t" }, {}, [], false);
  await Promise.resolve();
  assert.equal(seen[1], j.namespace.signal);
  release();
  await shared;
});

// A handler on a subshell can span a cell boundary (#421 review).
test("an interrupt aborts the signals of running work only, across cell boundaries", async () => {
  const j = jupyter();
  const seen: AbortSignal[] = [];
  const release: (() => void)[] = [];
  j.namespace.comm.registerTarget("t", async () => {
    seen.push(j.namespace.signal);
    await new Promise<void>((resolve) => release.push(resolve));
  });
  // A handler between cells, then a cell that starts and finishes while it waits.
  const own = j.commDispatch("comm_open", { comm_id: "a", target_name: "t" }, {}, [], true);
  await Promise.resolve();
  j.startCell();
  const finished = j.namespace.signal;
  j.abortSignal(false);
  assert.ok(seen[0].aborted, "the running handler's");
  assert.ok(!finished.aborted, "the finished cell's");
  release.shift()!();
  await own;

  // A handler that starts during cell A and outlives it, then cell B is interrupted.
  j.startCell();
  const a = j.namespace.signal;
  const shared = j.commDispatch("comm_open", { comm_id: "b", target_name: "t" }, {}, [], false);
  await Promise.resolve();
  assert.equal(seen[1], a);
  j.startCell();
  const b = j.namespace.signal;
  j.abortSignal(true);
  assert.ok(b.aborted, "the running cell's");
  assert.ok(a.aborted, "the outliving handler's, shared with cell A");
  release.shift()!();
  await shared;
});

test("the evaluator starts a cell on eval, passes ownSignal to comms and aborts on request", async () => {
  const calls: unknown[] = [];
  const shim = {
    startCell: () => calls.push("startCell"),
    abortSignal: (cell: boolean) => calls.push(["abort", cell]),
    commDispatch: (...args: unknown[]) => (calls.push(["comm", args[4]]), Promise.resolve(true)),
  } as unknown as EvaluatorShim;
  const handle = createHandler(shim, () => Promise.resolve([1]));
  await handle({ op: "eval", code: "" });
  await handle({ op: "comm", msgType: "comm_msg", content: {}, metadata: {}, buffers: [], ownSignal: true });
  await handle({ op: "abort", cell: false });
  await handle({ op: "abort" });
  assert.deepEqual(calls, ["startCell", ["comm", true], ["abort", false], ["abort", true]]);
});

// The cell announces a comm and waits for the frontend's answer on it,
// giving up when jupyter.signal aborts.
const AWAIT_REPLY = `
const comm = jupyter.comm.open("ask", {});
const signal = jupyter.signal;
try {
  await new Promise((resolve, reject) => {
    comm.onMsg((m) => resolve(m.data));
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
} catch (err) {
  log.push(err.name);
  comm.close();
} finally {
  log.push("ended");
}`;

const events: TargetEvents = { stream: () => {}, message: () => {}, exit: () => {} };

const targets: Record<string, { launch: () => Promise<KernelTarget>; skip: string | false }> = {
  node: { launch: () => Target.launch("node", events), skip: false },
  deno: { launch: () => Target.launch("deno", events), skip: !hasDeno && "deno not on PATH" },
  bun: { launch: () => BunTarget.launch(events), skip: !hasBun() && "bun not on PATH" },
  workerd: {
    launch: () => WorkerdTarget.launch(events, { executable: WORKERD }),
    // A Unix-domain socket, not supported on Windows yet (#32).
    skip: (!existsSync(WORKERD) || process.platform === "win32") && "needs workerd on a Unix-domain socket",
  },
};

async function launch(t: TestContext, start: () => Promise<KernelTarget>) {
  const target = await start();
  t.after(() => target.kill());
  // A boolean's text: Bun and workerd answer with a handle, not a value.
  const check = async (code: string) => {
    const res = await target.evaluate(target.transform(code, {}));
    assert.equal(res.exceptionDetails, undefined, JSON.stringify(res.exceptionDetails));
    // Without the colors.
    return String((await target.format(res.result))["text/plain"]).replace(/\x1b\[\d+m/g, "");
  };
  return { target, check };
}

const settle = () => new Promise((r) => setTimeout(r, 300));

for (const [name, { launch: start, skip }] of Object.entries(targets)) {
  test(`${name}: a cell awaiting a comm reply with jupyter.signal ends on interrupt`, { skip }, async (t) => {
    const { target, check } = await launch(t, start);
    await check("globalThis.log = []; globalThis.first = jupyter.signal; 0");
    assert.equal(await check("jupyter.signal !== first"), "true", "each cell's own signal");
    const cell = assert.rejects(target.evaluate(target.transform(AWAIT_REPLY, {})), Interrupted);
    await settle();
    await target.interrupt();
    await cell;
    await settle();
    assert.equal(await check(`log.join() === "AbortError,ended"`), "true", await check("log.join()"));
    assert.equal(await check("first.aborted"), "false", "a finished cell's signal");
    assert.equal(await check("jupyter.signal.aborted"), "false", "the next cell's signal");

    // A comm handler between cells gets its own signal, which an interrupt aborts.
    await check(`globalThis.seen = [];
      jupyter.comm.registerTarget("t", async () => {
        const signal = jupyter.signal;
        seen.push(signal.aborted);
        await new Promise((_, reject) => signal.addEventListener("abort", () => {
          seen.push("aborted");
          reject(signal.reason);
        }, { once: true }));
      }); 0`);
    const handler = assert.rejects(target.dispatchComm("comm_open", { comm_id: "c1", target_name: "t", data: {} }, {}, []), Interrupted);
    await settle();
    await target.interrupt();
    await handler;
    await settle();
    assert.equal(await check(`seen.join() === "false,aborted"`), "true", await check("seen.join()"));
  });
}

// An interrupt while a cell waits in prompt() unwinds the prompt (#121)
// without interrupting the target: the signal is aborted all the same.
test("node: interrupting a prompt aborts the signal", async (t) => {
  let target: Target | null = null;
  target = await Target.launch("node", {
    ...events,
    message: (msg) => {
      if (msg.kind === "input_request") target?.replyInput(null, true);
    },
  });
  t.after(() => target?.kill());
  const res = await target.evaluate(target.transform(`globalThis.inPrompt = jupyter.signal; prompt("q")`, {}));
  assert.ok(res.exceptionDetails, "the prompt threw");
  const after = await target.evaluate(target.transform("inPrompt.aborted && !jupyter.signal.aborted", {}));
  assert.equal(after.result.value, true);
});
