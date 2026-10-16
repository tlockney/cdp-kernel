import { test } from "node:test";
import assert from "node:assert/strict";
import { createComms } from "../runtime/comm.mjs";

interface Sent {
  msgType: string;
  content: Record<string, unknown>;
  metadata: Record<string, unknown>;
  buffers: Uint8Array[];
}

function harness() {
  const sent: Sent[] = [];
  let next = 0;
  const comms = createComms(
    (msgType, content, metadata, buffers) => {
      sent.push({ msgType, content: content as Record<string, unknown>, metadata: metadata as Record<string, unknown>, buffers });
    },
    () => `id-${++next}`,
  );
  return { sent, comms };
}

test("open sends comm_open with target, data, metadata and buffers", () => {
  const { sent, comms } = harness();
  const buf = new Uint8Array([1, 2, 3]);
  const comm = comms.api.open("my.target", { a: 1 }, { metadata: { version: "2.1.0" }, buffers: [buf] });
  assert.equal(comm.id, "id-1");
  assert.equal(comm.targetName, "my.target");
  assert.deepEqual(sent, [{
    msgType: "comm_open",
    content: { comm_id: "id-1", target_name: "my.target", data: { a: 1 } },
    metadata: { version: "2.1.0" },
    buffers: [buf],
  }]);
});

test("send and close produce comm_msg and comm_close; a closed comm sends nothing", () => {
  const { sent, comms } = harness();
  const comm = comms.api.open("t");
  comm.send({ x: 1 });
  comm.close({ bye: true });
  comm.send({ ignored: true });
  comm.close();
  assert.deepEqual(sent.map((m) => [m.msgType, m.content]), [
    ["comm_open", { comm_id: "id-1", target_name: "t", data: {} }],
    ["comm_msg", { comm_id: "id-1", data: { x: 1 } }],
    ["comm_close", { comm_id: "id-1", data: { bye: true } }],
  ]);
  assert.equal(comm.closed, true);
});

test("frontend comm_msg reaches onMsg handlers with data, metadata and buffers", async () => {
  const { comms } = harness();
  const comm = comms.api.open("t");
  const got: unknown[] = [];
  comm.onMsg((msg) => {
    got.push(msg);
  });
  const buf = new Uint8Array([9]);
  assert.equal(await comms.dispatch("comm_msg", { comm_id: "id-1", data: { hi: 1 } }, { m: 1 }, [buf]), true);
  assert.deepEqual(got, [{ data: { hi: 1 }, metadata: { m: 1 }, buffers: [buf] }]);
});

test("async handlers are awaited before dispatch resolves", async () => {
  const { comms } = harness();
  const comm = comms.api.open("t");
  let done = false;
  comm.onMsg(async () => {
    await new Promise((r) => setTimeout(r, 10));
    done = true;
  });
  await comms.dispatch("comm_msg", { comm_id: "id-1", data: {} }, {}, []);
  assert.equal(done, true);
});

test("frontend comm_open runs the registered target handler", async () => {
  const { sent, comms } = harness();
  const opened: { id: string; data: unknown }[] = [];
  comms.api.registerTarget("echo", (comm, msg) => {
    opened.push({ id: comm.id, data: msg.data });
    comm.onMsg((m) => comm.send({ echo: m.data }, { buffers: m.buffers }));
  });
  assert.equal(await comms.dispatch("comm_open", { comm_id: "front-1", target_name: "echo", data: { hello: true } }, {}, []), true);
  assert.deepEqual(opened, [{ id: "front-1", data: { hello: true } }]);
  const buf = new Uint8Array([7]);
  await comms.dispatch("comm_msg", { comm_id: "front-1", data: { n: 1 } }, {}, [buf]);
  // A frontend-opened comm sends no comm_open of its own.
  assert.deepEqual(sent, [{ msgType: "comm_msg", content: { comm_id: "front-1", data: { echo: { n: 1 } } }, metadata: {}, buffers: [buf] }]);
});

test("comm_open for an unknown target is reported as unhandled", async () => {
  const { comms } = harness();
  assert.equal(await comms.dispatch("comm_open", { comm_id: "x", target_name: "nobody", data: {} }, {}, []), false);
});

test("messages for unknown comms are reported as unhandled", async () => {
  const { comms } = harness();
  assert.equal(await comms.dispatch("comm_msg", { comm_id: "missing", data: {} }, {}, []), false);
  assert.equal(await comms.dispatch("comm_close", { comm_id: "missing", data: {} }, {}, []), false);
});

test("frontend comm_close runs onClose and stops further sends", async () => {
  const { sent, comms } = harness();
  const comm = comms.api.open("t");
  const closes: unknown[] = [];
  comm.onClose((msg) => {
    closes.push(msg.data);
  });
  assert.equal(await comms.dispatch("comm_close", { comm_id: "id-1", data: { why: "frontend" } }, {}, []), true);
  comm.send({ late: true });
  assert.deepEqual(closes, [{ why: "frontend" }]);
  assert.equal(comm.closed, true);
  assert.equal(sent.length, 1); // only the comm_open
  // The comm is gone: later messages for it are unhandled.
  assert.equal(await comms.dispatch("comm_msg", { comm_id: "id-1", data: {} }, {}, []), false);
});

test("closing from the kernel also runs onClose handlers", () => {
  const { comms } = harness();
  const comm = comms.api.open("t");
  let closed = 0;
  comm.onClose(() => {
    closed++;
  });
  comm.close();
  comm.close();
  assert.equal(closed, 1);
});

test("unregisterTarget stops accepting new comms for it", async () => {
  const { comms } = harness();
  comms.api.registerTarget("t", () => {});
  comms.api.unregisterTarget("t");
  assert.equal(await comms.dispatch("comm_open", { comm_id: "a", target_name: "t", data: {} }, {}, []), false);
});

test("a throwing handler rejects dispatch so the kernel can report it", async () => {
  const { comms } = harness();
  const comm = comms.api.open("t");
  comm.onMsg(() => {
    throw new Error("handler broke");
  });
  await assert.rejects(comms.dispatch("comm_msg", { comm_id: "id-1", data: {} }, {}, []), /handler broke/);
});

test("a comm_open handler that throws leaves no comm behind", async () => {
  const { sent, comms } = harness();
  let opened: { send(data?: object): void; closed: boolean } | undefined;
  comms.api.registerTarget("t", (comm) => {
    opened = comm;
    throw new Error("open broke");
  });
  await assert.rejects(comms.dispatch("comm_open", { comm_id: "a", target_name: "t", data: {} }, {}, []), /open broke/);
  assert.deepEqual(comms.list(), []);
  assert.equal(await comms.dispatch("comm_msg", { comm_id: "a", data: {} }, {}, []), false);
  // The frontend has been told it's closed, so the handle sends nothing.
  assert.equal(opened?.closed, true);
  opened?.send({ late: true });
  assert.deepEqual(sent, []);
});

test("open comms are listed with their targets", () => {
  const { comms } = harness();
  comms.api.open("a");
  const b = comms.api.open("b");
  b.close();
  assert.deepEqual(comms.list(), [{ commId: "id-1", targetName: "a" }]);
});
