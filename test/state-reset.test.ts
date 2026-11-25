// A runtime that is stopped, because an interrupt couldn't reach a busy
// cell or because it crashed, loses its state. The kernel marks the stderr
// note with `cdp_kernel` metadata so a frontend needn't match the text
// (#538). A fake Worker stands in for the browser target's driver; the
// Bun, workerd and celld targets' reason is asserted in their own tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KernelCore } from "../src/kernel-core.ts";
import { BrowserTarget, type WorkerLike } from "../src/browser/target.ts";
import { FakeChannels } from "./fake-channels.ts";
import type { OutgoingMessage } from "../src/message.ts";

type MessageListener = (event: { data: unknown }) => void;
type ErrorListener = (event: { message?: string }) => void;

class FakeWorker implements WorkerLike {
  /** An idle Worker answers a ping; a busy one doesn't. */
  busy = false;
  #message: MessageListener[] = [];
  #error: ErrorListener[] = [];
  addEventListener(type: "message", listener: MessageListener): void;
  addEventListener(type: "error", listener: ErrorListener): void;
  addEventListener(type: "message" | "error", listener: MessageListener | ErrorListener): void {
    if (type === "message") this.#message.push(listener as MessageListener);
    else this.#error.push(listener as ErrorListener);
  }
  postMessage(message: unknown): void {
    const msg = message as { op: string; id: number };
    if (msg.op === "info") queueMicrotask(() => this.emit({ kind: "reply", id: msg.id, userAgent: "Chrome/141" }));
    if (msg.op === "ping" && !this.busy) queueMicrotask(() => this.emit({ kind: "reply", id: msg.id }));
  }
  terminate(): void {}
  emit(data: unknown): void {
    for (const listener of this.#message) listener({ data });
  }
  fail(): void {
    for (const listener of this.#error) listener({ message: "boom" });
  }
}

async function start() {
  const channels = new FakeChannels();
  const worker = new FakeWorker();
  const core = new KernelCore({
    runtime: "browser",
    version: "0",
    channels,
    launchTarget: (events) => BrowserTarget.launch(events, { createWorker: () => worker, base: "https://app.test/" }),
    log: () => {},
    exit: () => {},
  });
  void core.run();
  // A cell in flight: its eval request is never answered.
  const id = channels.push("shell", "execute_request", { code: "1", silent: false });
  while (!channels.published.some((m) => m.header.msg_type === "execute_input")) await new Promise((r) => setTimeout(r, 5));
  return { channels, worker, id };
}

const stderr = (channels: FakeChannels): OutgoingMessage[] =>
  channels.published.filter((m) => m.header.msg_type === "stream" && m.content.name === "stderr");

test("interrupting a busy cell marks the restart note with state_reset metadata", async () => {
  const { channels, worker } = await start();
  worker.busy = true;
  channels.push("control", "interrupt_request");
  await channels.replyOf("execute_reply");
  const [note] = stderr(channels);
  assert.match(String(note.content.text), /can't be interrupted in place/);
  assert.deepEqual(note.metadata, { cdp_kernel: { state_reset: true, reason: "interrupt", runtime: "browser" } });
});

test("an interrupt answered in place publishes no state_reset metadata", async () => {
  const { channels } = await start();
  channels.push("control", "interrupt_request");
  await channels.replyOf("execute_reply");
  assert.deepEqual(stderr(channels), []);
  assert.ok(channels.published.every((m) => !("cdp_kernel" in m.metadata)));
});

test("a target that ends on its own is marked with reason exit", async () => {
  const { channels, worker } = await start();
  worker.fail();
  await channels.replyOf("execute_reply");
  const [note] = stderr(channels);
  assert.match(String(note.content.text), /browser Worker error: boom/);
  const reset = stderr(channels).find((m) => "cdp_kernel" in m.metadata);
  assert.deepEqual(reset?.metadata, { cdp_kernel: { state_reset: true, reason: "exit", runtime: "browser" } });
});
