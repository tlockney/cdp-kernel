import { test } from "node:test";
import assert from "node:assert/strict";
import { launchCommand, PipeDemux } from "../src/target.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function collector() {
  const texts: string[] = [];
  return { texts, onText: (t: string) => void texts.push(t), joined: () => texts.join("") };
}

test("PipeDemux passes plain text through", async () => {
  const c = collector();
  const demux = new PipeDemux(c.onText);
  demux.push("hello ");
  demux.push("world");
  await tick();
  assert.equal(c.joined(), "hello world");
});

test("PipeDemux strips markers and splits text around them", async () => {
  const c = collector();
  const demux = new PipeDemux(c.onText);
  demux.push("a\x1b[cdpk:1]\x1bb\x1b[cdpk:2]\x1bc");
  await tick();
  assert.deepEqual(c.texts, ["a", "b", "c"]);
  await demux.waitFor(2);
});

test("PipeDemux does not leak a marker split after its prefix", async () => {
  const c = collector();
  const demux = new PipeDemux(c.onText);
  demux.push("before\x1b[cdpk:7");
  await tick();
  assert.equal(c.joined(), "before");
  demux.push("]\x1bafter");
  await tick();
  assert.equal(c.joined(), "beforeafter");
  await demux.waitFor(7);
});

// A chunk boundary can fall inside the "\x1b[cdpk:" prefix itself.
test("PipeDemux does not leak a marker split inside its prefix", async () => {
  const c = collector();
  const demux = new PipeDemux(c.onText);
  demux.push("before\x1b[cdp");
  await tick();
  assert.equal(c.joined(), "before");
  demux.push("k:7]\x1bafter");
  await tick();
  assert.equal(c.joined(), "beforeafter");
});

test("PipeDemux waitFor resolves when the marker is reached and immediately for past markers", async () => {
  const demux = new PipeDemux(() => {});
  let reached = false;
  const pending = demux.waitFor(3).then(() => (reached = true));
  await tick();
  assert.equal(reached, false);
  demux.push("x\x1b[cdpk:3]\x1b");
  await pending;
  assert.equal(reached, true);
  await demux.waitFor(2);
  await demux.waitFor(3);
});

test("PipeDemux gated marker pauses later text until the gate resolves", async () => {
  const c = collector();
  const gateCalls: number[] = [];
  let release: () => void = () => {};
  const demux = new PipeDemux(c.onText, (n) => {
    gateCalls.push(n);
    return new Promise<void>((resolve) => (release = resolve));
  });
  demux.push("one\x1b[cdpk:4m]\x1btwo");
  await tick();
  assert.deepEqual(gateCalls, [4]);
  assert.equal(c.joined(), "one");
  // The marker itself counts as reached even while the pipe is paused.
  await demux.waitFor(4);
  const later = demux.waitFor(5);
  // A state dump says what the pipe waits on (#237).
  assert.deepEqual(demux.state(), { reached: 4, waitingFor: [5], gatedOn: 4, queued: 1, held: 0 });
  release();
  await tick();
  assert.equal(c.joined(), "onetwo");
  assert.equal(demux.state().gatedOn, null);
  demux.push("\x1b[cdpk:5]\x1b");
  await later;
});

test("PipeDemux ungated marker does not call the gate", async () => {
  const gateCalls: number[] = [];
  const demux = new PipeDemux(() => {}, (n) => {
    gateCalls.push(n);
    return Promise.resolve();
  });
  demux.push("\x1b[cdpk:1]\x1b");
  await tick();
  assert.deepEqual(gateCalls, []);
});

// Node and Deno send messages as records on stdout (#271).
const record = (barrier: number, extra = "") =>
  `\x1b[cdpk:<{"barrier":${barrier},"kind":"iopub","msg_type":"stream"${extra}}\x1b]`;

test("PipeDemux delivers a record in order and gates later text on it", async () => {
  const c = collector();
  const messages: unknown[] = [];
  let release: () => void = () => {};
  const demux = new PipeDemux(
    c.onText,
    () => new Promise<void>((resolve) => (release = resolve)),
    (msg) => void messages.push(msg),
  );
  demux.push(`one${record(3)}two`);
  await tick();
  assert.equal(c.joined(), "one");
  assert.deepEqual(messages, [{ barrier: 3, kind: "iopub", msg_type: "stream" }]);
  await demux.waitFor(3);
  assert.equal(demux.state().gatedOn, 3);
  release();
  await tick();
  assert.equal(c.joined(), "onetwo");
});

test("PipeDemux holds a record split across chunks, however long", async () => {
  const c = collector();
  const messages: unknown[] = [];
  const demux = new PipeDemux(c.onText, undefined, (msg) => void messages.push(msg));
  const text = `before${record(1, `,"data":"${"x".repeat(100_000)}"`)}after`;
  // Cut inside the prefix, the body, and between the terminator's two characters.
  const cuts = [text.indexOf("\x1b") + 3, 50_000, text.lastIndexOf("]")];
  let at = 0;
  for (const cut of cuts) {
    demux.push(text.slice(at, cut));
    at = cut;
    await tick();
    assert.equal(c.joined(), "before");
    assert.equal(messages.length, 0);
  }
  demux.push(text.slice(at));
  await tick();
  assert.equal(c.joined(), "beforeafter");
  assert.equal(messages.length, 1);
});

test("PipeDemux drops a record that isn't a message, and passes records through without onMessage", async () => {
  const c = collector();
  const messages: unknown[] = [];
  const demux = new PipeDemux(c.onText, undefined, (msg) => void messages.push(msg));
  demux.push("a\x1b[cdpk:<not json\x1b]b\x1b[cdpk:<{}\x1b]c");
  await tick();
  assert.equal(c.joined(), "abc");
  assert.deepEqual(messages, []);

  const plain = collector();
  const stderr = new PipeDemux(plain.onText);
  stderr.push(`x${record(1)}y`);
  await tick();
  assert.equal(plain.joined(), `x${record(1)}y`);
});

test("PipeDemux releases a record prefix once another escape shows it isn't one", async () => {
  const c = collector();
  const demux = new PipeDemux(c.onText, undefined, () => {});
  demux.push("\x1b[cdpk:<oops");
  await tick();
  assert.equal(c.joined(), "");
  demux.push(" \x1b[31mred\x1b[0m");
  await tick();
  assert.equal(c.joined(), "\x1b[cdpk:<oops \x1b[31mred\x1b[0m");
});

test("PipeDemux close flushes held text and releases waiters", async () => {
  const c = collector();
  const demux = new PipeDemux(c.onText);
  demux.push("tail\x1b[cdpk:1");
  await tick();
  assert.equal(c.joined(), "tail");
  const waiter = demux.waitFor(99);
  demux.close();
  await waiter;
  assert.equal(c.joined(), "tail\x1b[cdpk:1");
});

test("launchCommand for node", () => {
  const { cmd, args } = launchCommand("node", "/x/bootstrap.mjs");
  assert.equal(cmd, process.execPath);
  assert.ok(args.includes("--inspect=127.0.0.1:0"));
  assert.match(args[args.length - 1], /bootstrap\.mjs$/);
  assert.equal(launchCommand("node", "/x/bootstrap.mjs", { executable: "/opt/node" }).cmd, "/opt/node");
});

test("launchCommand for deno", () => {
  const { cmd, args } = launchCommand("deno", "/x/bootstrap.mjs");
  assert.equal(cmd, "deno");
  assert.equal(args[0], "run");
  assert.ok(args.includes("--inspect=127.0.0.1:0"));
  assert.ok(args.includes("--node-modules-dir=none"));
  assert.match(args[args.length - 1], /bootstrap\.mjs$/);
  assert.equal(launchCommand("deno", "/x/bootstrap.mjs", { executable: "/opt/deno" }).cmd, "/opt/deno");
});

test("launchCommand for deno inside a project uses its config", () => {
  const { args } = launchCommand("deno", "/x/bootstrap.mjs", { denoConfig: "/proj/deno.json" });
  const at = args.indexOf("--config");
  assert.deepEqual(args.slice(at, at + 2), ["--config", "/proj/deno.json"]);
  // The project's own nodeModulesDir setting applies instead.
  assert.ok(!args.includes("--node-modules-dir=none"));
  // Never write into the project's lockfile.
  assert.ok(args.includes("--no-lock"));
  assert.match(args[args.length - 1], /bootstrap\.mjs$/);
});

test("launchCommand ignores a deno config for node targets", () => {
  const { args } = launchCommand("node", "/x/bootstrap.mjs", { denoConfig: "/proj/deno.json" });
  assert.ok(!args.includes("--config"));
});
