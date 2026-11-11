// jupyter.host() (#461): the client for Ganymede's host API, over a comm
// the server opens. These drive it through the comm layer, as the server
// would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createComms } from "../runtime/comm.mjs";
import { createHost, HOST_TARGET, HostError } from "../runtime/host.mjs";

const HELLO = { protocol: 1, server: "0.8.0", notebook: "journal/a.ipynb", methods: ["notebooks.read", "notebooks.search"] };

function harness(signal?: () => AbortSignal | undefined) {
  const sent: { msgType: string; content: Record<string, any> }[] = [];
  let next = 0;
  const comms = createComms(
    (msgType, content) => {
      // As on the wire: content that isn't JSON throws.
      JSON.stringify(content);
      sent.push({ msgType, content: content as Record<string, any> });
    },
    () => `k-${++next}`,
  );
  const client = createHost(comms.api, signal);
  const dispatch = (msgType: string, content: Record<string, unknown>) => comms.dispatch(msgType, content, {}, []);
  /** The server opens the comm with its hello. */
  const open = (id = "srv", hello: unknown = HELLO) => dispatch("comm_open", { comm_id: id, target_name: HOST_TARGET, data: hello });
  const reply = (data: Record<string, unknown>, id = "srv") => dispatch("comm_msg", { comm_id: id, data });
  /** The calls the kernel sent. */
  const calls = () => sent.filter((m) => m.msgType === "comm_msg").map((m) => m.content.data);
  return { sent, client, dispatch, open, reply, calls };
}

test("a comm the server opens gives a Host from its hello", async () => {
  const { client, open } = harness();
  assert.equal(await open(), true);
  const host = await client.host();
  assert.ok(host);
  assert.equal(host.notebook, "journal/a.ipynb");
  assert.equal(host.server, "0.8.0");
  assert.equal(host.protocol, 1);
  assert.deepEqual(host.methods, ["notebooks.read", "notebooks.search"]);
  assert.equal(host.has("notebooks.search"), true);
  assert.equal(host.has("notebooks.run"), false);
});

test("a call sends { id, method, params } and resolves with the result", async () => {
  const { client, open, reply, calls } = harness();
  await open();
  const host = (await client.host())!;
  const read = host.notebooks.read({ path: "journal/b.ipynb" });
  const search = host.call("notebooks.search", { query: "drop" });
  assert.deepEqual(calls(), [
    { id: 0, method: "notebooks.read", params: { path: "journal/b.ipynb" } },
    { id: 1, method: "notebooks.search", params: { query: "drop" } },
  ]);
  // Replies may come in any order.
  await reply({ id: 1, result: { hits: [], total: 0, truncated: false } });
  await reply({ id: 0, result: { notebook: { cells: [] } } });
  assert.deepEqual(await search, { hits: [], total: 0, truncated: false });
  assert.deepEqual(await read, { notebook: { cells: [] } });
});

test("an error reply rejects with a HostError and its code", async () => {
  const { client, open, reply } = harness();
  await open();
  const host = (await client.host())!;
  const denied = host.notebooks.read({ path: "private/x.ipynb" });
  await reply({ id: 0, error: { code: "denied", message: "not granted: private/x.ipynb" } });
  await assert.rejects(denied, (err: unknown) => {
    assert.ok(err instanceof HostError);
    assert.equal(err.code, "denied");
    assert.equal(err.message, "not granted: private/x.ipynb");
    return true;
  });
  const odd = host.call("x");
  await reply({ id: 1, error: { code: "weird", message: "?" } });
  await assert.rejects(odd, { name: "HostError", code: "failed" });
});

test("an aborted signal cancels the call and tells the server", async () => {
  const { client, open, reply, calls } = harness();
  await open();
  const host = (await client.host())!;
  const controller = new AbortController();
  const call = host.notebooks.search({ query: "q" }, { signal: controller.signal });
  controller.abort(new DOMException("Execution interrupted", "AbortError"));
  await assert.rejects(call, { name: "HostError", code: "cancelled" });
  assert.deepEqual(calls().at(-1), { id: 0, cancel: true });
  // A late reply to it is ignored.
  await reply({ id: 0, result: "late" });
  // An already aborted signal sends nothing.
  await assert.rejects(host.call("x", {}, { signal: controller.signal }), { code: "cancelled" });
  assert.equal(calls().length, 2);
  await assert.rejects(host.call("x", {}, { signal: AbortSignal.abort(new DOMException("t", "TimeoutError")) }), { code: "timeout" });
});

test("a call without a signal watches the default one", async () => {
  let controller = new AbortController();
  const { client, open } = harness(() => controller.signal);
  await open();
  const host = (await client.host())!;
  const call = host.call("notebooks.read", { path: "a" });
  controller.abort(new DOMException("Execution interrupted", "AbortError"));
  await assert.rejects(call, { code: "cancelled" });
  controller = new AbortController();
  const next = host.call("notebooks.read", { path: "a" });
  // The next cell's signal: not aborted.
  let settled = false;
  next.then(() => (settled = true), () => (settled = true));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false);
});

test("closing the comm rejects pending calls with disconnected; later calls too", async () => {
  const { client, open, dispatch } = harness();
  await open();
  const host = (await client.host())!;
  const call = host.call("notebooks.read", { path: "a" });
  await dispatch("comm_close", { comm_id: "srv", data: {} });
  await assert.rejects(call, { name: "HostError", code: "disconnected" });
  await assert.rejects(host.call("notebooks.read"), { code: "disconnected" });
});

test("with no comm, host() opens one and takes the server's { hello }", async () => {
  const { client, sent, reply } = harness();
  const pending = client.host({ timeout: 5000 });
  assert.deepEqual(sent[0], { msgType: "comm_open", content: { comm_id: "k-1", target_name: HOST_TARGET, data: {} } });
  await reply({ hello: HELLO }, "k-1");
  const host = await pending;
  assert.equal(host?.notebook, "journal/a.ipynb");
  // Concurrent and later callers share it.
  assert.equal(await client.host(), host);
});

test("host() resolves null when nothing answers, and closes its comm", async () => {
  const { client, sent } = harness();
  const [a, b] = await Promise.all([client.host({ timeout: 20 }), client.host({ timeout: 20 })]);
  assert.equal(a, null);
  assert.equal(b, null);
  assert.deepEqual(sent.map((m) => m.msgType), ["comm_open", "comm_close"]);
});

test("host() resolves null at once when the frontend closes its comm", async () => {
  const { client, dispatch } = harness();
  const pending = client.host({ timeout: 60_000 });
  await dispatch("comm_close", { comm_id: "k-1", data: {} });
  assert.equal(await pending, null);
});

test("a new comm from the server replaces the old one", async () => {
  const { client, open, reply, sent } = harness();
  await open("first");
  const first = (await client.host())!;
  const pending = first.call("notebooks.read");
  await open("second", { ...HELLO, notebook: "journal/b.ipynb" });
  // The old comm is closed, and its calls end.
  await assert.rejects(pending, { code: "disconnected" });
  assert.ok(sent.some((m) => m.msgType === "comm_close" && m.content.comm_id === "first"));
  const second = (await client.host())!;
  assert.equal(second.notebook, "journal/b.ipynb");
  const call = second.call("notebooks.read");
  await reply({ id: 1, result: 1 }, "second");
  assert.equal(await call, 1);
});

test("an open without a hello waits for one", async () => {
  const { client, open, reply } = harness();
  await open("srv", {});
  const pending = client.host({ timeout: 5000 });
  await reply({ hello: HELLO });
  assert.equal((await pending)?.notebook, "journal/a.ipynb");
});

test("any abort reason but a timeout cancels", async () => {
  const { client, open } = harness();
  await open();
  const host = (await client.host())!;
  for (const reason of [new Error("stop"), "stop", undefined]) {
    const controller = new AbortController();
    const call = host.call("notebooks.read", {}, { signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(call, { name: "HostError", code: "cancelled" });
  }
});

test("params that can't be sent reject failed and leave nothing pending", async () => {
  const { client, open, calls } = harness();
  await open();
  const host = (await client.host())!;
  const controller = new AbortController();
  const odd = host.call("notebooks.search", { limit: 10n }, { signal: controller.signal });
  await assert.rejects(odd, { name: "HostError", code: "failed" });
  // Its abort listener is gone: no cancel for a call the server never got.
  controller.abort();
  assert.deepEqual(calls(), []);
});

test("an interrupt ends the wait for a server", async () => {
  const controller = new AbortController();
  const { client } = harness(() => controller.signal);
  const pending = client.host({ timeout: 200 });
  controller.abort(new DOMException("Execution interrupted", "AbortError"));
  await assert.rejects(pending, { name: "HostError", code: "cancelled" });
  await assert.rejects(client.host(), { code: "cancelled" });
});

test("no server is remembered until one opens the comm", async () => {
  const { client, sent, open } = harness();
  assert.equal(await client.host({ timeout: 10 }), null);
  const opens = sent.filter((m) => m.msgType === "comm_open").length;
  const started = Date.now();
  assert.equal(await client.host({ timeout: 5000 }), null);
  assert.ok(Date.now() - started < 1000, "answered at once");
  assert.equal(sent.filter((m) => m.msgType === "comm_open").length, opens, "no new open");
  await open();
  assert.equal((await client.host())?.notebook, "journal/a.ipynb");
});

test("each caller waits its own timeout", async () => {
  const { client, sent, reply } = harness();
  const long = client.host({ timeout: 5000 });
  const started = Date.now();
  assert.equal(await client.host({ timeout: 10 }), null);
  assert.ok(Date.now() - started < 1000);
  // The longer wait still holds the comm open, and gets the hello.
  assert.ok(!sent.some((m) => m.msgType === "comm_close"));
  await reply({ hello: HELLO }, "k-1");
  assert.equal((await long)?.notebook, "journal/a.ipynb");
});

test("a server's comm without a hello is not closed on timeout", async () => {
  const { client, open, sent } = harness();
  await open("srv", {});
  assert.equal(await client.host({ timeout: 10 }), null);
  assert.ok(!sent.some((m) => m.msgType === "comm_close"));
});

test("a Node target registers the host target at start", async (t) => {
  const { Target } = await import("../src/target.ts");
  const { loadTypeStripper } = await import("../src/transform.ts");
  await loadTypeStripper("esbuild");
  const target = await Target.launch("node", { stream: () => {}, message: () => {}, exit: () => {} });
  t.after(() => target.kill());
  assert.deepEqual(await target.dispatchComm("comm_open", { comm_id: "srv", target_name: HOST_TARGET, data: HELLO }, {}, []), { handled: true });
  const res = await target.evaluate(target.transform("(await jupyter.host())?.notebook", {}));
  assert.equal(res.exceptionDetails, undefined, JSON.stringify(res.exceptionDetails));
  assert.equal(res.result.value, "journal/a.ipynb");
});
