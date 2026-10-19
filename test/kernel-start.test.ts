// A target that is slow to start, or never starts, doesn't wedge the cell
// waiting for it: interrupt_request ends that cell (#336).
import { test } from "node:test";
import assert from "node:assert/strict";
import { type ChannelName, type KernelChannels, KernelCore, type Received } from "../src/kernel-core.ts";
import type { KernelMessage, OutgoingMessage } from "../src/message.ts";
import type { KernelTarget } from "../src/target-api.ts";

/** In-memory channels: requests are pushed in, replies and iopub collected. */
class FakeChannels implements KernelChannels {
  readonly ready = Promise.resolve();
  readonly replies: OutgoingMessage[] = [];
  readonly published: OutgoingMessage[] = [];
  readonly #queues = new Map<ChannelName, Received[]>();
  readonly #waiting = new Map<ChannelName, (received: Received) => void>();
  #onReply: () => void = () => {};

  push(channel: ChannelName, msgType: string, content: KernelMessage["content"] = {}): void {
    const msg: KernelMessage = {
      header: { msg_id: crypto.randomUUID(), session: "s", date: "", username: "u", msg_type: msgType, version: "5.3" },
      parentHeader: {},
      metadata: {},
      content,
      buffers: [],
    };
    const waiting = this.#waiting.get(channel);
    this.#waiting.delete(channel);
    if (waiting) waiting({ peer: "p", msg });
    else this.#queues.set(channel, [...(this.#queues.get(channel) ?? []), { peer: "p", msg }]);
  }

  recv(channel: ChannelName): Promise<Received | null> {
    const queued = this.#queues.get(channel)?.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.#waiting.set(channel, resolve));
  }

  shellQueued(): number {
    return this.#queues.get("shell")?.length ?? 0;
  }

  reply(_channel: ChannelName, _peer: string, msg: OutgoingMessage): void {
    this.replies.push(msg);
    this.#onReply();
  }

  publish(msg: OutgoingMessage): void {
    this.published.push(msg);
  }

  stdinPeers(): number {
    return 0;
  }

  sendStdin(): void {}

  /** The first reply of this type, once it is sent. */
  async replyOf(msgType: string): Promise<OutgoingMessage> {
    for (;;) {
      const found = this.replies.find((m) => m.header.msg_type === msgType);
      if (found) return found;
      await new Promise<void>((resolve) => (this.#onReply = resolve));
    }
  }
}

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
