// The language comm (#522): signature help, definition and rename for
// frontends, which the kernel answers itself, src/kernel-core.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KernelCore, LANGUAGE_TARGET, type TypeService } from "../src/kernel-core.ts";
import type { OutgoingMessage } from "../src/message.ts";
import { FakeChannels } from "./fake-channels.ts";

/** A kernel whose runtime never starts: the comm mustn't need it. */
function kernel(types: TypeService | null) {
  const channels = new FakeChannels();
  const core = new KernelCore({
    runtime: "test",
    version: "0",
    channels,
    launchTarget: () => new Promise(() => {}),
    types,
    log: () => {},
    exit: () => {},
  });
  void core.run();
  return { channels };
}

async function publishedFor(channels: FakeChannels, msgType: string, parentId: string): Promise<OutgoingMessage> {
  for (let i = 0; i < 400; i++) {
    const found = channels.published.find((m) => m.header.msg_type === msgType && m.parentHeader.msg_id === parentId);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`no ${msgType}`);
}

/** What the service was asked, and what it answers. */
function service(answers: Partial<TypeService> = {}) {
  const asked: unknown[][] = [];
  const types: TypeService = {
    reset() {},
    addCell() {},
    complete: async () => null,
    quickInfo: async () => null,
    signature: async (...args) => (asked.push(["signature", ...args]), answers.signature?.(...args) ?? null),
    definition: async (...args) => (asked.push(["definition", ...args]), answers.definition?.(...args) ?? null),
    rename: async (...args) => (asked.push(["rename", ...args]), answers.rename?.(...args) ?? null),
  };
  return { types, asked };
}

/** Opens the comm and sends `data`; the answer's data. */
async function ask(channels: FakeChannels, commId: string, data: Record<string, unknown>) {
  const id = channels.push("shell", "comm_msg", { comm_id: commId, data });
  const reply = await publishedFor(channels, "comm_msg", id);
  assert.equal(reply.content.comm_id, commId);
  return reply.content.data;
}

// "😀" is two UTF-16 units and one code point.
const cells = ["const s = '😀'; const total = 1;", "total + 1;"];
const total = [...cells[0]].indexOf("t", 20); // code point of "total" in cell 0
const total16 = cells[0].indexOf("total");

test("signature: the kernel answers without the runtime, with the cursor in code points", async () => {
  const signature = { label: "f(a: number): void", documentation: "", parameters: [{ label: "a: number", documentation: "" }], activeParameter: 0 };
  const { types, asked } = service({ signature: async () => signature });
  const { channels } = kernel(types);
  channels.push("shell", "comm_open", { comm_id: "l1", target_name: LANGUAGE_TARGET, data: {} });
  const code = "const s = '😀'; f(";
  const data = await ask(channels, "l1", { request: { n: 1 }, op: "signature", code, cursor: [...code].length });
  assert.deepEqual(data, { request: { n: 1 }, signature });
  assert.deepEqual(asked, [["signature", code, code.length]]);

  const info = channels.push("shell", "comm_info_request", { target_name: LANGUAGE_TARGET });
  assert.deepEqual((await channels.replyOf("comm_info_reply", info)).content.comms, { l1: { target_name: LANGUAGE_TARGET } });
  channels.push("shell", "comm_close", { comm_id: "l1", data: {} });
  const after = channels.push("shell", "comm_info_request", {});
  assert.deepEqual((await channels.replyOf("comm_info_reply", after)).content.comms, {});
});

test("definition: locations come back in code points of their cell", async () => {
  const { types, asked } = service({ definition: async () => [{ cell: 0, start: total16, end: total16 + 5 }] });
  const { channels } = kernel(types);
  channels.push("shell", "comm_open", { comm_id: "l2", target_name: LANGUAGE_TARGET, data: {} });
  const data = await ask(channels, "l2", { request: "d", op: "definition", cells, cell: 1, cursor: 1 });
  assert.deepEqual(data, { request: "d", locations: [{ cell: 0, start: total, end: total + 5 }] });
  assert.equal(total16, total + 1);
  assert.deepEqual([...cells[0]].slice(total, total + 5).join(""), "total");
  assert.deepEqual(asked, [["definition", cells, 1, 1]]);
});

test("rename: edits come back in code points, and the cursor is read in code points", async () => {
  const { types, asked } = service({
    rename: async () => ({
      edits: [{ cell: 0, start: total16, end: total16 + 5, text: "sum" }, { cell: 1, start: 0, end: 5, text: "sum" }],
    }),
  });
  const { channels } = kernel(types);
  channels.push("shell", "comm_open", { comm_id: "l3", target_name: LANGUAGE_TARGET, data: {} });
  // Cursor on "total" in cell 0, counted in code points.
  const data = await ask(channels, "l3", { request: 3, op: "rename", cells, cell: 0, cursor: total, newName: "sum" });
  assert.deepEqual(data, {
    request: 3,
    edits: [{ cell: 0, start: total, end: total + 5, text: "sum" }, { cell: 1, start: 0, end: 5, text: "sum" }],
  });
  assert.deepEqual(asked, [["rename", cells, 0, total16, "sum"]]);
});

test("rename: a name that can't be renamed answers with an error", async () => {
  const { types } = service({ rename: async () => ({ error: "You cannot rename this element." }) });
  const { channels } = kernel(types);
  channels.push("shell", "comm_open", { comm_id: "l4", target_name: LANGUAGE_TARGET, data: {} });
  const data = await ask(channels, "l4", { request: null, op: "rename", cells, cell: 1, cursor: 0, newName: "x" });
  assert.deepEqual(data, { request: null, error: "You cannot rename this element." });
});

test("answers the language service can't give are null", async () => {
  const { types } = service();
  const { channels } = kernel(types);
  channels.push("shell", "comm_open", { comm_id: "l5", target_name: LANGUAGE_TARGET, data: {} });
  assert.deepEqual(await ask(channels, "l5", { request: 1, op: "signature", code: "f(", cursor: 2 }), { request: 1, signature: null });
  assert.deepEqual(await ask(channels, "l5", { request: 2, op: "definition", cells, cell: 1, cursor: 0 }), { request: 2, locations: null });
  assert.deepEqual(await ask(channels, "l5", { request: 3, op: "rename", cells, cell: 1, cursor: 0, newName: "x" }), { request: 3, edits: null });
});

test("a request the kernel can't read gets an answer, and never reaches the service", async () => {
  const { types, asked } = service({ definition: async () => [], rename: async () => ({ edits: [] }) });
  const { channels } = kernel(types);
  channels.push("shell", "comm_open", { comm_id: "l6", target_name: LANGUAGE_TARGET, data: {} });
  assert.deepEqual(await ask(channels, "l6", { request: 1, op: "frobnicate" }), { request: 1, error: 'unknown op: "frobnicate"' });
  for (const bad of [{ cells: "x", cell: 0 }, { cells: [1], cell: 0 }, { cells, cell: 2 }, { cells, cell: -1 }, { cells, cell: 0.5 }, { cells, cell: "0" }]) {
    assert.deepEqual(await ask(channels, "l6", { request: 2, op: "definition", cursor: 0, ...bad }), { request: 2, locations: null }, JSON.stringify(bad));
  }
  // A cursor that isn't a number.
  for (const op of ["definition", "rename"]) {
    const data = await ask(channels, "l6", { request: 4, op, cells, cell: 0, cursor: "0", newName: "x" });
    assert.deepEqual(data, { request: 4, [op === "definition" ? "locations" : "edits"]: null });
  }
  assert.deepEqual(await ask(channels, "l6", { request: 3, op: "rename", cells, cell: 0, cursor: 0 }), { request: 3, edits: null });
  assert.deepEqual(asked, []);
});

test("without a language service the kernel closes the language comm", async () => {
  const { channels } = kernel(null);
  const id = channels.push("shell", "comm_open", { comm_id: "l7", target_name: LANGUAGE_TARGET, data: {} });
  assert.deepEqual((await publishedFor(channels, "comm_close", id)).content, { comm_id: "l7", data: {} });
});

test("a service without these requests closes the language comm", async () => {
  const { channels } = kernel({ reset() {}, addCell() {}, complete: async () => null, quickInfo: async () => null });
  const id = channels.push("shell", "comm_open", { comm_id: "l8", target_name: LANGUAGE_TARGET, data: {} });
  assert.deepEqual((await publishedFor(channels, "comm_close", id)).content, { comm_id: "l8", data: {} });
});
