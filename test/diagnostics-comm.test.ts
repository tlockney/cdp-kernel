// The diagnostics comm (#514): type errors for a cell being edited, which
// the kernel answers itself, src/kernel-core.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DIAGNOSTICS_TARGET, KernelCore, type TypeService } from "../src/kernel-core.ts";
import type { CellDiagnostic } from "../src/notebook-types.ts";
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

/** The first iopub message of this type that answers `parentId`. */
async function publishedFor(channels: FakeChannels, msgType: string, parentId: string): Promise<OutgoingMessage> {
  for (let i = 0; i < 400; i++) {
    const found = channels.published.find((m) => m.header.msg_type === msgType && m.parentHeader.msg_id === parentId);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`no ${msgType}`);
}

function types(diagnostics: (code: string) => CellDiagnostic[] | null): TypeService {
  return {
    reset() {},
    addCell() {},
    complete: async () => null,
    quickInfo: async () => null,
    diagnostics: async (code) => diagnostics(code),
  };
}

test("the kernel answers the diagnostics comm without the runtime, in code points", async () => {
  const asked: string[] = [];
  // "😀" is two UTF-16 units and one code point.
  const code = "const s = '😀';\nconst n: string = 1";
  const { channels } = kernel(types((c) => {
    asked.push(c);
    return [{ start: 22, end: 23, severity: "error", code: 2322, message: "Type 'number' is not assignable to type 'string'." }];
  }));
  channels.push("shell", "comm_open", { comm_id: "d1", target_name: DIAGNOSTICS_TARGET, data: {} });
  const id = channels.push("shell", "comm_msg", { comm_id: "d1", data: { request: 7, code } });
  const reply = await publishedFor(channels, "comm_msg", id);
  assert.deepEqual(reply.content, {
    comm_id: "d1",
    data: {
      request: 7,
      diagnostics: [{ start: 21, end: 22, severity: "error", code: 2322, message: "Type 'number' is not assignable to type 'string'." }],
    },
  });
  assert.equal([...code][21], "n");
  assert.deepEqual(asked, [code]);

  const info = channels.push("shell", "comm_info_request", { target_name: DIAGNOSTICS_TARGET });
  assert.deepEqual((await channels.replyOf("comm_info_reply", info)).content.comms, { d1: { target_name: DIAGNOSTICS_TARGET } });
  channels.push("shell", "comm_close", { comm_id: "d1", data: {} });
  const after = channels.push("shell", "comm_info_request", {});
  assert.deepEqual((await channels.replyOf("comm_info_reply", after)).content.comms, {});
});

test("diagnostics the language service can't give are null", async () => {
  const { channels } = kernel(types(() => null));
  channels.push("shell", "comm_open", { comm_id: "d2", target_name: DIAGNOSTICS_TARGET, data: {} });
  const id = channels.push("shell", "comm_msg", { comm_id: "d2", data: { request: "a", code: "1 +" } });
  assert.deepEqual((await publishedFor(channels, "comm_msg", id)).content.data, { request: "a", diagnostics: null });
});

test("without a language service the kernel closes the diagnostics comm", async () => {
  const { channels } = kernel(null);
  const id = channels.push("shell", "comm_open", { comm_id: "d3", target_name: DIAGNOSTICS_TARGET, data: {} });
  assert.deepEqual((await publishedFor(channels, "comm_close", id)).content, { comm_id: "d3", data: {} });
});
