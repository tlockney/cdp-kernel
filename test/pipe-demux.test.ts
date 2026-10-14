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
  release();
  await tick();
  assert.equal(c.joined(), "onetwo");
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
  const { cmd, args } = launchCommand("node");
  assert.equal(cmd, process.execPath);
  assert.ok(args.includes("--inspect=127.0.0.1:0"));
  assert.match(args[args.length - 1], /bootstrap\.mjs$/);
  assert.equal(launchCommand("node", "/opt/node").cmd, "/opt/node");
});

test("launchCommand for deno", () => {
  const { cmd, args } = launchCommand("deno");
  assert.equal(cmd, "deno");
  assert.equal(args[0], "run");
  assert.ok(args.includes("--inspect=127.0.0.1:0"));
  assert.ok(args.includes("--node-modules-dir=none"));
  assert.match(args[args.length - 1], /bootstrap\.mjs$/);
  assert.equal(launchCommand("deno", "/opt/deno").cmd, "/opt/deno");
});
