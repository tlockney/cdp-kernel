// jupyter.signal (#418): an interrupt aborts it, so a cell waiting on
// something the interrupt can't reach, such as a comm reply, can stop; the
// next cell gets a new one. test/browser.test.ts covers the browser target.
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

test("the signal stays the same until aborted, and is renewed only once aborted", () => {
  const j = jupyter();
  const first = j.namespace.signal;
  j.renewSignal();
  assert.equal(j.namespace.signal, first, "renewed without an interrupt");
  j.abortSignal();
  assert.ok(first.aborted);
  assert.equal(first.reason.name, "AbortError");
  assert.equal(first.reason.message, "Execution interrupted");
  // Code the interrupt abandoned still sees it aborted, until a cell starts.
  assert.equal(j.namespace.signal, first);
  j.renewSignal();
  assert.notEqual(j.namespace.signal, first);
  assert.ok(!j.namespace.signal.aborted);
});

test("the evaluator aborts the signal on request and renews it for the next cell", async () => {
  const j = jupyter();
  const shim = { abortSignal: j.abortSignal, renewSignal: j.renewSignal } as unknown as EvaluatorShim;
  const handle = createHandler(shim, () => Promise.resolve([j.namespace.signal.aborted]));
  const first = j.namespace.signal;
  await handle({ op: "abort" });
  assert.ok(first.aborted);
  await handle({ op: "eval", code: "" });
  assert.ok(!j.namespace.signal.aborted);
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
    await check("globalThis.log = []; globalThis.before = jupyter.signal; 0");
    assert.equal(await check("jupyter.signal === before"), "true", "a new signal without an interrupt");
    const cell = assert.rejects(target.evaluate(target.transform(AWAIT_REPLY, {})), Interrupted);
    await settle();
    await target.interrupt();
    await cell;
    await settle();
    assert.equal(await check(`log.join() === "AbortError,ended"`), "true", await check("log.join()"));
    assert.equal(await check("before.aborted"), "true");
    assert.equal(await check("jupyter.signal !== before && !jupyter.signal.aborted"), "true", "the next cell's signal");
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
  const before = await target.evaluate(target.transform("globalThis.before = jupyter.signal; 0", {}));
  assert.equal(before.exceptionDetails, undefined);
  const res = await target.evaluate(target.transform(`prompt("q")`, {}));
  assert.ok(res.exceptionDetails, "the prompt threw");
  const after = await target.evaluate(target.transform("before.aborted && !jupyter.signal.aborted", {}));
  assert.equal(after.result.value, true);
});
