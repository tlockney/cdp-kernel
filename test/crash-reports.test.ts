// Opt-in reports of the kernel's own faults (#422): off without
// CDP_KERNEL_CRASH_REPORTS=1, scrubbed, and never for a cell's error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEvent, crashReporter, DSN, packageFile, parseStack, scrubText } from "../src/crash-reports.ts";
import { KernelCore, type TypeService } from "../src/kernel-core.ts";
import { Target } from "../src/target.ts";
import type { KernelTarget } from "../src/target-api.ts";
import { FakeChannels } from "./fake-channels.ts";

test("off unless CDP_KERNEL_CRASH_REPORTS is 1", () => {
  assert.equal(crashReporter({ env: {} }), null);
  assert.equal(crashReporter({ env: { CDP_KERNEL_CRASH_REPORTS: "0" } }), null);
  assert.equal(crashReporter({ env: { CDP_KERNEL_CRASH_REPORTS: "true" } }), null);
  assert.notEqual(crashReporter({ env: { CDP_KERNEL_CRASH_REPORTS: "1" } }), null);
});

test("scrubText drops homes, URL hosts and length", () => {
  assert.equal(
    scrubText("ENOENT /Users/thomas/nb/a.ts from http://127.0.0.1:9229/json?x=1"),
    "ENOENT ~/nb/a.ts from /json",
  );
  assert.equal(scrubText("/home/dev/x"), "~/x");
  assert.equal(scrubText("x".repeat(500)).length, 301);
});

test("packageFile keeps the kernel's own files by their path in the package", () => {
  assert.equal(packageFile("file:///Users/t/src/cdp-kernel/src/kernel-core.ts"), "app:///src/kernel-core.ts");
  assert.equal(packageFile("/usr/lib/node_modules/@tlockney/cdp-kernel/dist/kernel.js"), "app:///dist/kernel.js");
  assert.equal(
    packageFile("https://jsr.io/@tlockney/cdp-kernel/0.7.2/src/wire.ts"),
    "app:///src/wire.ts",
  );
  assert.equal(packageFile("/Users/t/notebooks/cell.ts"), null);
});

test("parseStack lists frames oldest first, hiding files outside the package", () => {
  const frames = parseStack(
    [
      "Error: boom",
      "    at decode (file:///Users/t/cdp-kernel/src/wire.ts:10:5)",
      "    at /Users/t/notebooks/helper.js:3:1",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
    ].join("\n"),
  );
  assert.deepEqual(frames, [
    { filename: "node:internal/process/task_queues", function: "process.processTicksAndRejections", lineno: 105, colno: 5, in_app: false },
    { filename: "<other>", function: undefined, lineno: undefined, colno: undefined, in_app: false },
    { filename: "app:///src/wire.ts", function: "decode", lineno: 10, colno: 5, in_app: true },
  ]);
});

test("buildEvent carries the error, version and runtimes, no host name", () => {
  const event = buildEvent(new TypeError("bad /Users/t/x"), { where: "shell handler", target: "deno" });
  const exception = (event.exception as { values: { type: string; value: string }[] }).values[0];
  assert.equal(exception.type, "TypeError");
  assert.equal(exception.value, "bad ~/x");
  assert.match(String(event.release), /^cdp-kernel@\d/);
  assert.deepEqual(event.tags, { where: "shell handler", host: "node", target: "deno" });
  assert.ok(!JSON.stringify(event).includes("server_name"));
});

test("a report is one envelope to the project's ingest endpoint", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const reporter = crashReporter({
    env: { CDP_KERNEL_CRASH_REPORTS: "1" },
    send: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response("{}");
    },
  })!;
  await reporter.report(new Error("internal"), "control handler");
  assert.equal(calls.length, 1);
  const dsn = new URL(DSN);
  assert.equal(calls[0].url, `https://${dsn.host}/api${dsn.pathname}/envelope/`);
  assert.match(String((calls[0].init.headers as Record<string, string>)["x-sentry-auth"]), new RegExp(`sentry_key=${dsn.username}`));
  const [header, item, event] = String(calls[0].init.body).split("\n").map((l) => JSON.parse(l));
  assert.equal(header.event_id, event.event_id);
  assert.deepEqual(item, { type: "event" });
  assert.equal(event.exception.values[0].value, "internal");
});

test("a failed send never throws, and reports stop after ten", async () => {
  let sends = 0;
  const reporter = crashReporter({
    env: { CDP_KERNEL_CRASH_REPORTS: "1" },
    send: () => {
      sends++;
      return Promise.reject(new Error("offline"));
    },
  })!;
  for (let i = 0; i < 15; i++) await reporter.report(new Error(`e${i}`), "shell handler");
  assert.equal(sends, 10);
});

function kernel(options: { launch: () => Promise<KernelTarget>; types?: TypeService }) {
  const channels = new FakeChannels();
  const faults: { err: unknown; where: string }[] = [];
  let target: KernelTarget | null = null;
  const core = new KernelCore({
    runtime: "test",
    version: "0",
    channels,
    launchTarget: async () => (target = await options.launch()),
    types: options.types,
    log: () => {},
    fault: (err, where) => faults.push({ err, where }),
    exit: () => {},
  });
  void core.run();
  return { channels, faults, stop: () => (core.stopping(), target?.kill()) };
}

test("a fault in a shell handler reaches the host", async () => {
  const { channels, faults, stop } = kernel({
    launch: () => Promise.reject(new Error("internal: no target")),
  });
  try {
    const id = channels.push("shell", "complete_request", { code: "a", cursor_pos: 1 });
    assert.equal((await channels.replyOf("complete_reply", id)).content.status, "error");
    while (faults.length === 0) await new Promise((r) => setTimeout(r, 5));
    assert.equal(faults[0].where, "shell handler");
    assert.match(String(faults[0].err), /no target/);
  } finally {
    stop();
  }
});

test("a cell that throws is not a fault", async () => {
  const { channels, faults, stop } = kernel({ launch: () => Target.launch("node", { stream() {}, message() {}, exit() {} }) });
  try {
    const id = channels.push("shell", "execute_request", { code: 'throw new Error("user code")', silent: false });
    const reply = await channels.replyOf("execute_reply", id);
    assert.equal(reply.content.status, "error");
    assert.equal(reply.content.evalue, "user code");
    const rejected = channels.push("shell", "execute_request", { code: 'await Promise.reject(new TypeError("async user code"))', silent: false });
    assert.equal((await channels.replyOf("execute_reply", rejected)).content.status, "error");
    assert.deepEqual(faults, []);
  } finally {
    stop();
  }
});
