// Opt-in crash reports of the kernel's own faults (#422): off without a
// DSN, only #384's fields sent, and never a cell's errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { ErrorEvent } from "@sentry/core";
import { scrubEvent, scrubText } from "../src/crash-report.ts";
import { KernelCore } from "../src/kernel-core.ts";
import { Target } from "../src/target.ts";
import type { KernelTarget, TargetEvents } from "../src/target-api.ts";
import { FakeChannels } from "./fake-channels.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const CRASH_REPORT = new URL("../src/crash-report.ts", import.meta.url).href;

const paths = { packageRoots: ["/opt/app/node_modules/@tlockney/cdp-kernel/"], home: "/home/ada" };

test("scrubEvent keeps only the error, its frames' locations, version, OS and architecture", () => {
  const event = {
    type: undefined,
    event_id: "e1",
    timestamp: 1,
    platform: "node",
    level: "error",
    release: "cdp-kernel@1.0.0",
    server_name: "ada-laptop.local",
    user: { ip_address: "10.0.0.2", username: "ada" },
    request: { url: "http://localhost/", data: "cell source" },
    extra: { code: "secret()" },
    breadcrumbs: [{ message: "cell output" }],
    modules: { left: "1.0.0" },
    contexts: {
      os: { name: "linux", version: "6.1" },
      device: { arch: "x64" },
      runtime: { name: "node", version: "22.0.0" },
      app: { app_memory: 1 },
      culture: { timezone: "Europe/London" },
    },
    exception: {
      values: [{
        type: "TypeError",
        value: "cannot read /home/ada/notebooks/plan.ipynb",
        stacktrace: {
          frames: [
            {
              filename: "/opt/app/node_modules/@tlockney/cdp-kernel/dist/kernel-core.js",
              function: "KernelCore.#complete",
              lineno: 10,
              colno: 4,
              context_line: "const secret = 1;",
              pre_context: ["a"],
              post_context: ["b"],
              vars: { secret: "1" },
              module: "ada.kernel-core",
            },
            { filename: "/opt/app/node_modules/@tlockney/cdp-kernel/node_modules/esbuild/lib/main.js", lineno: 1 },
            { filename: "/home/ada/elsewhere.js", lineno: 2 },
          ],
        },
      }],
    },
  } as unknown as ErrorEvent;
  const sent = scrubEvent(event, paths);
  for (const field of ["server_name", "user", "request", "extra", "breadcrumbs", "modules"]) {
    assert.equal(field in sent, false, field);
  }
  assert.deepEqual(Object.keys(sent.contexts ?? {}).sort(), ["device", "os", "runtime"]);
  const [ex] = sent.exception?.values ?? [];
  assert.equal(ex.value, "cannot read ~/notebooks/plan.ipynb");
  assert.deepEqual(ex.stacktrace?.frames, [
    { in_app: true, filename: "cdp-kernel/dist/kernel-core.js", function: "KernelCore.#complete", lineno: 10, colno: 4 },
    { in_app: false, filename: "cdp-kernel/node_modules/esbuild/lib/main.js", lineno: 1 },
    { in_app: false, filename: "~/elsewhere.js", lineno: 2 },
  ]);
  assert.equal(JSON.stringify(sent).includes("ada"), false);
});

test("scrubText cuts long messages", () => {
  const text = scrubText("x".repeat(2_000), paths);
  assert.equal(text.length, 501);
});

/** A kernel whose faults are collected in `reports`. */
function kernel(launch: (events: TargetEvents) => Promise<KernelTarget>) {
  const channels = new FakeChannels();
  const reports: { err: unknown; where: string }[] = [];
  let target: KernelTarget | null = null;
  const core = new KernelCore({
    runtime: "test",
    version: "0",
    channels,
    launchTarget: async (events) => (target = await launch(events)),
    log: () => {},
    report: (err, where) => reports.push({ err, where }),
    exit: () => {},
  });
  void core.run();
  return { channels, reports, stop: () => (core.stopping(), target?.kill()) };
}

test("a fault in the kernel's own handling is reported", async () => {
  const bug = new TypeError("kernel bug");
  const target = {
    runtime: "node",
    versions: { runtime: "0", engine: "0" },
    propertyNames: async () => {
      throw bug;
    },
    lexicalNames: async () => [],
    kill: () => {},
  } as unknown as KernelTarget;
  const { channels, reports, stop } = kernel(async () => target);
  try {
    const id = channels.push("shell", "complete_request", { code: "x", cursor_pos: 1 });
    await channels.replyOf("complete_reply", id);
    while (reports.length === 0) await new Promise((r) => setTimeout(r, 5));
    assert.equal(reports[0].err, bug);
    assert.equal(reports[0].where, "error handling message");
  } finally {
    stop();
  }
});

test("a cell's errors are not reported", async () => {
  const { channels, reports, stop } = kernel((events) => Target.launch("node", events));
  try {
    for (
      const code of [
        `throw new Error("in a cell")`,
        `let = ;`,
        `Promise.reject(new Error("unhandled in a cell")); 1`,
        `JSON.parse("{")`,
      ]
    ) {
      const id = channels.push("shell", "execute_request", { code, silent: false });
      await channels.replyOf("execute_reply", id);
    }
    // The unhandled rejection is reported by the target after the cell.
    const id = channels.push("shell", "execute_request", { code: `await new Promise((r) => setTimeout(r, 100))`, silent: false });
    await channels.replyOf("execute_reply", id);
    assert.deepEqual(reports, []);
  } finally {
    stop();
  }
});

/** A stand-in for Sentry's ingest: the envelopes it was sent. */
async function fakeSentry(t: { after(fn: () => void): void }) {
  const envelopes: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      envelopes.push(body);
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  return { envelopes, dsn: `http://publickey@127.0.0.1:${port}/1` };
}

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Preloaded: says on stderr if anything resolves a @sentry package. */
const SENTRY_GUARD = `data:text/javascript,${
  encodeURIComponent(`
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@sentry/")) process.stderr.write("LOADED " + specifier + "\\n");
    return next(specifier, context);
  },
});`)
}`;

test("without a DSN the Sentry SDK isn't loaded", async () => {
  const off = await run(["--import", SENTRY_GUARD, MAIN, "report-test"], { CDP_KERNEL_SENTRY_DSN: "" });
  assert.equal(off.code, 2);
  assert.doesNotMatch(off.stderr, /LOADED/);
  // The guard does see it when reports are on.
  const on = await run(["--import", SENTRY_GUARD, MAIN, "report-test", "--sentry-dsn", "http://k@127.0.0.1:9/1"]);
  assert.match(on.stderr, /LOADED @sentry\/core/);
});

test("report-test sends one event, from the environment variable's DSN", async (t) => {
  const sentry = await fakeSentry(t);
  const { code, stdout } = await run([MAIN, "report-test"], { CDP_KERNEL_SENTRY_DSN: sentry.dsn });
  assert.equal(code, 0, stdout);
  assert.equal(sentry.envelopes.length, 1);
  const event = JSON.parse(sentry.envelopes[0].split("\n")[2]);
  assert.equal(event.exception.values[0].value, "cdp-kernel report-test");
  assert.equal(event.tags.where, "report-test");
  assert.match(event.release, /^cdp-kernel@/);
});

test("report-test fails when Sentry can't be reached", async () => {
  const { code, stderr } = await run([MAIN, "report-test", "--sentry-dsn", "http://k@127.0.0.1:9/1"]);
  assert.equal(code, 1);
  assert.match(stderr, /report-test:/);
});

test("an uncaught exception in the kernel process is reported before it exits", async (t) => {
  const sentry = await fakeSentry(t);
  const script = `
    import { startCrashReports } from ${JSON.stringify(CRASH_REPORT)};
    await startCrashReports(${JSON.stringify(sentry.dsn)}, "node", () => {});
    setTimeout(() => { throw new RangeError("escaped"); }, 0);
    setTimeout(() => {}, 60_000);
  `;
  const { code, stderr } = await run(["--input-type=module", "-e", script]);
  assert.equal(code, 1);
  assert.match(stderr, /uncaught: RangeError: escaped/);
  assert.equal(sentry.envelopes.length, 1);
  const event = JSON.parse(sentry.envelopes[0].split("\n")[2]);
  assert.equal(event.exception.values[0].type, "RangeError");
  assert.deepEqual(event.exception.values[0].mechanism, { type: "uncaught", handled: false });
});
