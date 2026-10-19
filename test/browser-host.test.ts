// The page's side of the browser target's host requests (#384), with a
// fake Worker standing in for runtime/browser-worker.mjs. test/browser.test.ts
// covers the Worker's side in a real browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserTarget, type BrowserTargetOptions, type HostHandler, type WorkerLike } from "../src/browser/target.ts";
import type { TargetEvents } from "../src/target-api.ts";

type Listener = (event: { data: unknown }) => void;

class FakeWorker implements WorkerLike {
  readonly sent: Record<string, unknown>[] = [];
  terminated = false;
  #listeners: Listener[] = [];
  addEventListener(type: "message" | "error", listener: Listener | ((event: { message?: string }) => void)): void {
    if (type === "message") this.#listeners.push(listener as Listener);
  }
  postMessage(message: unknown): void {
    const msg = message as Record<string, unknown>;
    this.sent.push(msg);
    // The driver's answer to "info", so launch() resolves.
    if (msg.op === "info") queueMicrotask(() => this.emit({ kind: "reply", id: msg.id, userAgent: "Chrome/141" }));
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(data: unknown): void {
    for (const listener of this.#listeners) listener({ data });
  }
  /** The host replies sent so far. */
  hostReplies(): Record<string, unknown>[] {
    return this.sent.filter((m) => m.op === "host");
  }
}

const events: TargetEvents = { stream() {}, message() {}, exit() {} };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function launch(options: Partial<BrowserTargetOptions> = {}) {
  const worker = new FakeWorker();
  const target = await BrowserTarget.launch(events, { createWorker: () => worker, base: "https://app.test/", ...options });
  return { worker, target };
}

test("info carries the preload list", async () => {
  const { worker } = await launch({ preload: ["./device.mjs"] });
  assert.deepEqual(worker.sent[0].preload, ["./device.mjs"]);
  assert.deepEqual((await launch()).worker.sent[0].preload, []);
});

test("a host request is answered with the handler's result", async () => {
  const seen: unknown[] = [];
  const host: HostHandler = (request) => {
    seen.push(request);
    return { text: "copied" };
  };
  const { worker } = await launch({ host });
  worker.emit({ kind: "host", id: 1, method: "clipboard.readText", params: { a: 1 } });
  await tick();
  assert.deepEqual(seen, [{ method: "clipboard.readText", params: { a: 1 } }]);
  assert.deepEqual(worker.hostReplies(), [{ op: "host", id: 1, result: { text: "copied" } }]);
});

test("a handler's error reaches the Worker with its name, message and code", async () => {
  const host: HostHandler = () => {
    throw Object.assign(new Error("not allowed"), { name: "DeviceError", code: "denied" });
  };
  const { worker } = await launch({ host });
  worker.emit({ kind: "host", id: 7, method: "location.current", params: {} });
  await tick();
  assert.deepEqual(worker.hostReplies(), [{ op: "host", id: 7, error: { name: "DeviceError", message: "not allowed", code: "denied" } }]);
});

test("without a handler, host requests are refused", async () => {
  const { worker } = await launch();
  worker.emit({ kind: "host", id: 1, method: "x", params: null });
  await tick();
  const [reply] = worker.hostReplies();
  assert.match(String((reply.error as { message: string }).message), /offers no host requests/);
});

test("cancelling a host request aborts its signal and sends no reply", async () => {
  let signal: AbortSignal | undefined;
  let finish!: (value: unknown) => void;
  const host: HostHandler = (_request, s) => {
    signal = s;
    return new Promise((resolve) => (finish = resolve));
  };
  const { worker } = await launch({ host });
  worker.emit({ kind: "host", id: 3, method: "ui.alert", params: {} });
  await tick();
  assert.equal(signal?.aborted, false);
  worker.emit({ kind: "host", id: 3, cancel: true });
  assert.equal(signal?.aborted, true);
  finish("late");
  await tick();
  assert.deepEqual(worker.hostReplies(), []);
});

test("a Worker that stops aborts every host request in flight", async () => {
  const signals: AbortSignal[] = [];
  const host: HostHandler = (_request, s) => {
    signals.push(s);
    return new Promise(() => {});
  };
  const { worker, target } = await launch({ host });
  worker.emit({ kind: "host", id: 1, method: "a", params: {} });
  worker.emit({ kind: "host", id: 2, method: "b", params: {} });
  await tick();
  target.kill();
  assert.equal(worker.terminated, true);
  assert.deepEqual(signals.map((s) => s.aborted), [true, true]);
});

test("notifyHost sends an event until the Worker stops", async () => {
  const { worker, target } = await launch();
  target.notifyHost("appearance", "dark");
  assert.deepEqual(worker.hostReplies(), [{ op: "host", event: "appearance", value: "dark" }]);
  target.kill();
  target.notifyHost("appearance", "light");
  assert.equal(worker.hostReplies().length, 1);
});
