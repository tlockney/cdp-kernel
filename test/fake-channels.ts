// In-memory KernelChannels for driving a KernelCore in unit tests.
import type { ChannelName, KernelChannels, Received } from "../src/kernel-core.ts";
import type { KernelMessage, OutgoingMessage } from "../src/message.ts";

/** In-memory channels: requests are pushed in, replies and iopub collected. */
export class FakeChannels implements KernelChannels {
  readonly ready = Promise.resolve();
  readonly replies: OutgoingMessage[] = [];
  readonly published: OutgoingMessage[] = [];
  readonly #queues = new Map<ChannelName, Received[]>();
  readonly #waiting = new Map<ChannelName, (received: Received) => void>();
  #onReply: () => void = () => {};

  /** Sends a request; returns its msg_id. `header` adds fields, e.g. a subshell_id. */
  push(channel: ChannelName, msgType: string, content: KernelMessage["content"] = {}, header: Record<string, unknown> = {}): string {
    const msg: KernelMessage = {
      header: { msg_id: crypto.randomUUID(), session: "s", date: "", username: "u", msg_type: msgType, version: "5.5", ...header },
      parentHeader: {},
      metadata: {},
      content,
      buffers: [],
    };
    const waiting = this.#waiting.get(channel);
    this.#waiting.delete(channel);
    if (waiting) waiting({ peer: "p", msg });
    else this.#queues.set(channel, [...(this.#queues.get(channel) ?? []), { peer: "p", msg }]);
    return msg.header.msg_id;
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

  /** The first reply of this type (to `parentId`, if given), once it is sent. */
  async replyOf(msgType: string, parentId?: string): Promise<OutgoingMessage> {
    for (;;) {
      const found = this.replies.find((m) =>
        m.header.msg_type === msgType && (parentId === undefined || m.parentHeader.msg_id === parentId)
      );
      if (found) return found;
      await new Promise<void>((resolve) => (this.#onReply = resolve));
    }
  }
}
