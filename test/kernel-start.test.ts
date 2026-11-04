// A target that is slow to start, or never starts, doesn't wedge the cell
// waiting for it: interrupt_request ends that cell (#336).
import { test } from "node:test";
import assert from "node:assert/strict";
import { KernelCore } from "../src/kernel-core.ts";
import { FakeChannels } from "./fake-channels.ts";
import type { KernelTarget } from "../src/target-api.ts";

test("interrupt_request ends a cell waiting on a target that hasn't started", async () => {
  const channels = new FakeChannels();
  let launches = 0;
  const core = new KernelCore({
    runtime: "node",
    version: "0",
    channels,
    // A runtime that never becomes ready.
    launchTarget: () => {
      launches++;
      return new Promise<KernelTarget>(() => {});
    },
    log: () => {},
    exit: () => {},
  });
  void core.run();
  channels.push("shell", "execute_request", { code: "1", silent: false });
  // The cell is waiting once its input has been published.
  while (!channels.published.some((m) => m.header.msg_type === "execute_input")) await new Promise((r) => setTimeout(r, 5));
  channels.push("control", "interrupt_request");

  const reply = await channels.replyOf("execute_reply");
  assert.equal(reply.content.status, "error");
  assert.equal(reply.content.ename, "Interrupted");
  assert.equal((await channels.replyOf("interrupt_reply")).content.status, "ok");
  // The start goes on for the next cell rather than starting another runtime.
  assert.equal(launches, 1);
});
