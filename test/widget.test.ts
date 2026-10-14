import { test } from "node:test";
import assert from "node:assert/strict";
import { createComms } from "../runtime/comm.mjs";
import { createWidgetFactory, WIDGET_PROTOCOL_VERSION } from "../runtime/widget.mjs";
import { $display } from "../runtime/display.mjs";

interface Sent {
  msgType: string;
  content: { comm_id: string; target_name?: string; data: Record<string, unknown> };
  metadata: Record<string, unknown>;
  buffers: Uint8Array[];
}

function harness() {
  const sent: Sent[] = [];
  let next = 0;
  const comms = createComms((msgType, content, metadata, buffers) => {
    sent.push({ msgType, content: content as Sent["content"], metadata: metadata as Record<string, unknown>, buffers });
  }, () => `w-${++next}`);
  const widget = createWidgetFactory(comms.api, $display);
  return { sent, comms, widget };
}

const ESM = "export default { render({ model, el }) { el.textContent = model.get('count'); } }";

test("widget() opens a jupyter.widget comm with anywidget's model state", () => {
  const { sent, widget } = harness();
  const w = widget({ esm: ESM, css: ".x{}", state: { count: 0 } });
  assert.equal(w.id, "w-1");
  assert.equal(sent.length, 1);
  const open = sent[0];
  assert.equal(open.msgType, "comm_open");
  assert.equal(open.content.target_name, "jupyter.widget");
  assert.deepEqual(open.metadata, { version: WIDGET_PROTOCOL_VERSION });
  assert.deepEqual(open.content.data, {
    state: {
      _model_name: "AnyModel",
      _model_module: "anywidget",
      _model_module_version: "*",
      _view_name: "AnyView",
      _view_module: "anywidget",
      _view_module_version: "*",
      _view_count: null,
      _esm: ESM,
      _css: ".x{}",
      _anywidget_id: "cdp-kernel.widget",
      count: 0,
    },
    buffer_paths: [],
  });
});

test("the widget displays as a widget view of its model", () => {
  const { widget } = harness();
  const w = widget({ esm: ESM });
  const bundle = w[$display]();
  assert.deepEqual(bundle["application/vnd.jupyter.widget-view+json"], {
    version_major: 2,
    version_minor: 1,
    model_id: "w-1",
  });
  assert.equal(typeof bundle["text/plain"], "string");
});

test("set() updates local state and sends only the changed keys", () => {
  const { sent, widget } = harness();
  const w = widget({ esm: ESM, state: { count: 0, label: "a" } });
  w.set("count", 1);
  w.set({ label: "b", extra: true });
  assert.equal(w.get("count"), 1);
  assert.equal(w.get("label"), "b");
  assert.deepEqual(sent.slice(1).map((m) => m.content.data), [
    { method: "update", state: { count: 1 }, buffer_paths: [] },
    { method: "update", state: { label: "b", extra: true }, buffer_paths: [] },
  ]);
});

test("a frontend update changes state and fires change events without echoing back", async () => {
  const { sent, comms, widget } = harness();
  const w = widget({ esm: ESM, state: { count: 0 } });
  const events: unknown[] = [];
  w.on("change:count", (value, old) => {
    events.push(["count", value, old]);
  });
  w.on("change", (changes) => {
    events.push(["any", changes]);
  });
  const handled = await comms.dispatch("comm_msg", {
    comm_id: "w-1",
    data: { method: "update", state: { count: 5 }, buffer_paths: [] },
  }, {}, []);
  assert.equal(handled, true);
  assert.equal(w.get("count"), 5);
  assert.deepEqual(events, [["count", 5, 0], ["any", { count: 5 }]]);
  assert.equal(sent.length, 1); // just the comm_open
});

test("off() removes a listener", async () => {
  const { comms, widget } = harness();
  const w = widget({ esm: ESM, state: { count: 0 } });
  let calls = 0;
  const listener = () => {
    calls++;
  };
  w.on("change:count", listener);
  w.off("change:count", listener);
  await comms.dispatch("comm_msg", { comm_id: "w-1", data: { method: "update", state: { count: 1 } } }, {}, []);
  assert.equal(calls, 0);
});

test("request_state is answered with the full state", async () => {
  const { sent, comms, widget } = harness();
  widget({ esm: ESM, state: { count: 3 } });
  await comms.dispatch("comm_msg", { comm_id: "w-1", data: { method: "request_state" } }, {}, []);
  const reply = sent[sent.length - 1];
  assert.equal(reply.msgType, "comm_msg");
  const data = reply.content.data as { method: string; state: Record<string, unknown> };
  assert.equal(data.method, "update");
  assert.equal(data.state.count, 3);
  assert.equal(data.state._model_name, "AnyModel");
});

test("custom messages flow both ways with buffers", async () => {
  const { sent, comms, widget } = harness();
  const w = widget({ esm: ESM });
  const got: unknown[] = [];
  w.on("msg:custom", (content, buffers) => {
    got.push([content, buffers]);
  });
  const inBuf = new Uint8Array([1]);
  await comms.dispatch("comm_msg", { comm_id: "w-1", data: { method: "custom", content: { ping: 1 } } }, {}, [inBuf]);
  assert.deepEqual(got, [[{ ping: 1 }, [inBuf]]]);
  const outBuf = new Uint8Array([2]);
  w.send({ pong: 1 }, [outBuf]);
  const last = sent[sent.length - 1];
  assert.deepEqual(last.content.data, { method: "custom", content: { pong: 1 } });
  assert.deepEqual(last.buffers, [outBuf]);
});

test("binary state travels as buffers at buffer_paths, both ways", async () => {
  const { sent, comms, widget } = harness();
  const pixels = new Uint8Array([1, 2, 3]);
  const w = widget({ esm: ESM, state: { image: { pixels, width: 3 } } });
  const open = sent[0];
  assert.deepEqual(open.content.data.buffer_paths, [["image", "pixels"]]);
  assert.deepEqual((open.content.data.state as Record<string, { pixels: unknown }>).image.pixels, null);
  assert.deepEqual(open.buffers, [pixels]);
  // Local state keeps the bytes.
  assert.equal((w.get("image") as { pixels: Uint8Array }).pixels, pixels);

  const incoming = new Uint8Array([9, 9]);
  await comms.dispatch("comm_msg", {
    comm_id: "w-1",
    data: { method: "update", state: { image: { pixels: null, width: 2 } }, buffer_paths: [["image", "pixels"]] },
  }, {}, [incoming]);
  assert.deepEqual(w.get("image"), { pixels: incoming, width: 2 });
});

test("the frontend's control comm gets every live widget's state", async () => {
  const { sent, comms, widget } = harness();
  widget({ esm: ESM, state: { count: 1 } });
  const closed = widget({ esm: ESM, state: { count: 2 } });
  closed.close();
  assert.equal(await comms.dispatch("comm_open", { comm_id: "ctl", target_name: "jupyter.widget.control", data: {} }, {}, []), true);
  await comms.dispatch("comm_msg", { comm_id: "ctl", data: { method: "request_states" } }, {}, []);
  const reply = sent[sent.length - 1];
  assert.equal(reply.content.comm_id, "ctl");
  const data = reply.content.data as {
    method: string;
    states: Record<string, { model_name: string; model_module: string; model_module_version: string; state: Record<string, unknown> }>;
  };
  assert.equal(data.method, "update_states");
  assert.deepEqual(Object.keys(data.states), ["w-1"]);
  assert.equal(data.states["w-1"].model_name, "AnyModel");
  assert.equal(data.states["w-1"].model_module, "anywidget");
  assert.equal(data.states["w-1"].state.count, 1);
});

test("ArrayBuffer and DataView state values are sent as bytes", () => {
  const { sent, widget } = harness();
  const raw = new Uint8Array([4, 5, 6, 7]);
  widget({ esm: ESM, state: { ab: raw.buffer, view: new DataView(raw.buffer, 1, 2) } });
  const open = sent[0];
  assert.deepEqual(open.content.data.buffer_paths, [["ab"], ["view"]]);
  assert.deepEqual(open.buffers.map((b) => [...b]), [[4, 5, 6, 7], [5, 6]]);
});

test("a closed widget no longer sends updates", () => {
  const { sent, widget } = harness();
  const w = widget({ esm: ESM, state: { count: 0 } });
  w.close();
  w.set("count", 1);
  assert.deepEqual(sent.map((m) => m.msgType), ["comm_open", "comm_close"]);
});
