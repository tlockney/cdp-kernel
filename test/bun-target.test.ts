// BunTarget against a real Bun (#7): the host side of the fd 3 channel,
// without a Jupyter frontend. test/e2e.py's bun variant covers the kernel
// end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BunTarget, bunLaunchCommand, RESTART_NOTE } from "../src/bun-target.ts";
import { Interrupted, type TargetEvents, type TargetMessage } from "../src/target.ts";
import { hasBun } from "./bun.ts";

type Event = { stream: string; text: string } | { message: TargetMessage } | { exit: number | null; note?: string };

async function launch(t: { after(fn: () => void): void }) {
  const events: Event[] = [];
  const handlers: TargetEvents = {
    stream: (stream, text) => void events.push({ stream, text }),
    message: (message) => void events.push({ message }),
    exit: (exit, note) => void events.push({ exit, note }),
  };
  const target = await BunTarget.launch(handlers);
  t.after(() => target.kill());
  const run = async (cell: string) => {
    const result = await target.evaluate(target.transform(cell, {}));
    await target.flush();
    return result;
  };
  return { target, events, run };
}

const skip = !hasBun();

test("bunLaunchCommand runs the bootstrap with plain bun", () => {
  assert.deepEqual(bunLaunchCommand("/r/bootstrap.mjs"), { cmd: "bun", args: ["/r/bootstrap.mjs"] });
  assert.deepEqual(bunLaunchCommand("/r/bootstrap.mjs", "/opt/bun"), { cmd: "/opt/bun", args: ["/r/bootstrap.mjs"] });
});

test("launch reports Bun's version and engine", { skip }, async (t) => {
  const { target } = await launch(t);
  assert.match(target.versions.runtime, /^\d+\.\d+\.\d+/);
  assert.match(target.versions.engine, /^JavaScriptCore/);
  assert.equal(target.runtime, "bun");
});

test("cells share state, and results come back as handles", { skip }, async (t) => {
  const { target, run } = await launch(t);
  assert.deepEqual((await run("const a: number = 40")).result, { type: "undefined" });
  const { result } = await run("a + 2");
  assert.equal(result.type, "number");
  assert.equal(typeof result.objectId, "string");
  assert.ok((await target.propertyNames("globalThis")).includes("a"));
  assert.deepEqual(await target.lexicalNames(), []);
});

test("stdout and display messages arrive in the order the cell made them", { skip }, async (t) => {
  const { events, run } = await launch(t);
  await run('console.log("before"); await jupyter.display(jupyter.md`mid`); console.log("after")');
  const order = events.flatMap((e) =>
    "stream" in e ? [e.text] : "message" in e && e.message.kind === "iopub" ? [e.message.msg_type] : []
  );
  assert.deepEqual(order.join(""), "before\ndisplay_dataafter\n");
});

test("a thrown error is described by name, message and stack", { skip }, async (t) => {
  const { target, run } = await launch(t);
  const { exceptionDetails } = await run("throw new RangeError('out')");
  assert.ok(exceptionDetails?.exception);
  const described = await target.describeError(exceptionDetails.exception);
  assert.equal(described.name, "RangeError");
  assert.equal(described.message, "out");
  assert.match(described.stack, /RangeError: out/);
});

test("interrupting an awaiting cell abandons it and keeps the session", { skip }, async (t) => {
  const { target, events, run } = await launch(t);
  await run("globalThis.kept = 'state'");
  const pending = target.evaluate(target.transform("await new Promise(() => {})", {}));
  await new Promise((r) => setTimeout(r, 200));
  await target.interrupt();
  await assert.rejects(pending, Interrupted);
  const { result } = await run("kept");
  assert.equal(result.type, "string");
  assert.ok(!events.some((e) => "exit" in e), "bun kept running");
});

test("interrupting a busy cell stops bun and says why", { skip }, async (t) => {
  const { target, events } = await launch(t);
  const pending = target.evaluate(target.transform("while (true) {}", {}));
  await new Promise((r) => setTimeout(r, 200));
  await target.interrupt();
  await assert.rejects(pending, Interrupted);
  assert.deepEqual(events.find((e) => "exit" in e), { exit: null, note: RESTART_NOTE });
});

test("comm messages reach registered targets", { skip }, async (t) => {
  const { target, run } = await launch(t);
  await run('jupyter.comm.registerTarget("t", () => {}); jupyter.comm.registerTarget("bad", () => { throw new Error("no") })');
  assert.deepEqual(await target.dispatchComm("comm_open", { comm_id: "c1", target_name: "t", data: {} }, {}, []), {
    handled: true,
  });
  assert.deepEqual(await target.dispatchComm("comm_open", { comm_id: "c2", target_name: "none", data: {} }, {}, []), {
    handled: false,
  });
  const failed = await target.dispatchComm("comm_open", { comm_id: "c3", target_name: "bad", data: {} }, {}, []);
  assert.ok("error" in failed && failed.error.message === "no", JSON.stringify(failed));
});

test("prompt() blocks on stdin for the host's reply", { skip }, async (t) => {
  const { target, events, run } = await launch(t);
  const result = target.evaluate(target.transform("prompt('Name?')", {}));
  for (let i = 0; i < 100 && !events.some((e) => "message" in e && e.message.kind === "input_request"); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  target.replyInput("Ada");
  assert.equal((await result).result.type, "string");
  await run("1");
});

// Bun queues writes to a non-blocking pipe for its event loop, which
// prompt()'s blocking read stops (#180).
for (const write of ["process.stdout.write", "console.log", "console.error"]) {
  test(`prompt() after ${write} of more than the pipe holds gets its reply`, { skip }, async (t) => {
    const { target, events, run } = await launch(t);
    await run(`jupyter.broadcast("warm", {})`); // stdout and stderr now exist
    const result = target.evaluate(target.transform(`${write}("x".repeat(300_000) + "\\n"); prompt("Name?")`, {}));
    for (let i = 0; i < 250 && !events.some((e) => "message" in e && e.message.kind === "input_request"); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const chars = () => events.reduce((n, e) => n + ("text" in e ? e.text.replaceAll(/\x1b\[cdpk:\d+m?\]\x1b/g, "").length : 0), 0);
    assert.ok(events.some((e) => "message" in e && e.message.kind === "input_request"), `no input_request after ${chars()} chars`);
    // The output came before the request, not after it.
    assert.ok(chars() >= 300_001, `${chars()} chars before the input_request`);
    target.replyInput("Ada");
    assert.equal((await result).result.type, "string");
  });
}
