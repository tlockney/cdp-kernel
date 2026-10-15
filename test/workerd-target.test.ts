// The workerd target (#8): config generation, binary lookup and import
// bundling as units, then WorkerdTarget against the real workerd from
// devDependencies. test/e2e.py's workerd variant covers the kernel end to
// end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import {
  bundleModule,
  compatibilityDateOf,
  findWorkerd,
  importSpecifiers,
  RESTART_NOTE,
  WORKER_MODULES,
  workerdConfig,
  WorkerdTarget,
} from "../src/workerd-target.ts";
import { Interrupted, type TargetEvents, type TargetMessage } from "../src/target.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const WORKERD = join(REPO, "node_modules", ".bin", "workerd");
const skip = !existsSync(WORKERD);

function scratch(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "cdpk-wd-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("workerdConfig serves the driver on a Unix socket with UnsafeEval and secret bindings", () => {
  const config = workerdConfig({ socket: "/tmp/x y/sock", compatibilityDate: "2026-10-15" });
  assert.match(config, /address = "unix:\/tmp\/x y\/sock"/);
  assert.match(config, /\(name = "UNSAFE", unsafeEval = void\)/);
  assert.match(config, /\(name = "TOKEN", fromEnvironment = "CDPK_TOKEN"\)/);
  assert.match(config, /compatibilityDate = "2026-10-15"/);
  assert.match(config, /tlsOptions = \(trustBrowserCas = true\)/);
  for (const name of WORKER_MODULES) assert.ok(config.includes(`esModule = embed "${name}"`), name);
  assert.ok(config.indexOf(WORKER_MODULES[0]) < config.indexOf(WORKER_MODULES[1]), "main module first");
  assert.doesNotMatch(config, /\d+\.\d+\.\d+\.\d+:\d+/, "no TCP listener");
});

test("workerdConfig lists nodejs_compat only before it became the default", () => {
  assert.match(workerdConfig({ socket: "/s", compatibilityDate: "2026-08-03" }), /compatibilityFlags = \["nodejs_compat"\]/);
  assert.match(workerdConfig({ socket: "/s", compatibilityDate: "2026-08-04" }), /compatibilityFlags = \[\]/);
});

test("findWorkerd prefers a project's node_modules, then PATH", (t) => {
  const dir = scratch(t);
  const nested = join(dir, "notebooks", "deep");
  mkdirSync(nested, { recursive: true });
  assert.equal(findWorkerd(nested), "workerd");
  // npm's bin shim on Windows is workerd.cmd (#32).
  const bin = process.platform === "win32" ? "workerd.cmd" : "workerd";
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(dir, "node_modules", ".bin", bin), "");
  assert.equal(findWorkerd(nested), join(dir, "node_modules", ".bin", bin));
});

test("compatibilityDateOf reads workerd --version", () => {
  assert.equal(compatibilityDateOf("workerd 2026-10-15\n"), "2026-10-15");
  assert.throws(() => compatibilityDateOf("something else"), /can't read a date/);
});

test("importSpecifiers finds the literal imports of a transformed cell", () => {
  const script = 'var m0 = await __cdpk.import("./a.ts"); var x = await __cdpk.import("npm:p@1", { with: {} }); ' +
    '__cdpk.import("./a.ts"); __cdpk.import("q\\"uote"); __cdpk.import(dynamic)';
  assert.deepEqual(importSpecifiers(script), ["./a.ts", "npm:p@1", 'q"uote']);
});

/** Evaluates a bundle as the worker would, with builtins from `builtins`. */
async function load(script: string, builtins: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const context = createContext({
    __cdpk: {
      requireFor: (specifiers: string[]) =>
        Promise.resolve((s: string) => {
          assert.ok(specifiers.includes(s), `${s} was declared external`);
          return builtins[s];
        }),
    },
  });
  return await runInContext(script, context);
}

test("bundleModule bundles a relative TypeScript module and its imports", async (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, "dep.ts"), "export const base: number = 40;\n");
  writeFileSync(join(dir, "mod.ts"), 'import { base } from "./dep.ts";\nexport const answer = base + 2;\nexport default "D";\n');
  const ns = await load(await bundleModule("./mod.ts", dir));
  assert.equal(ns.answer, 42);
  assert.equal(ns.default, "D");
});

test("bundleModule bundles node_modules packages, CommonJS included, as namespaces", async (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, "node_modules", "cjs-pkg"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "cjs-pkg", "package.json"), '{ "name": "cjs-pkg", "main": "index.js" }');
  writeFileSync(join(dir, "node_modules", "cjs-pkg", "index.js"), "module.exports = { hello: () => 'hi' };\n");
  const ns = await load(await bundleModule("cjs-pkg", dir));
  assert.equal((ns.default as { hello(): string }).hello(), "hi");
});

test("bundleModule leaves builtins external, for the worker to supply", async (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, "uses.ts"), 'import { join } from "node:path";\nimport fs from "fs";\nexport const j = join("a", "b"), f = typeof fs;\n');
  const ns = await load(await bundleModule("./uses.ts", dir), {
    "node:path": { join: (a: string, b: string) => `${a}/${b}` },
    fs: { readFileSync() {} },
  });
  assert.equal(ns.j, "a/b");
  assert.equal(ns.f, "object");
});

test("bundleModule turns a missing module into an import-time error", async (t) => {
  const dir = scratch(t);
  await assert.rejects(load(await bundleModule("./missing.ts", dir)), (err: unknown) => {
    assert.equal((err as Error).name, "TypeError");
    assert.match((err as Error).message, /Cannot import "\.\/missing\.ts": Could not resolve/);
    return true;
  });
});

// --- Against a real workerd -------------------------------------------------

type Event = { stream: string; text: string } | { message: TargetMessage } | { exit: number | null; note?: string };

async function launch(t: { after(fn: () => void): void }, cwd?: string) {
  const events: Event[] = [];
  const handlers: TargetEvents = {
    stream: (stream, text) => void events.push({ stream, text }),
    message: (message) => void events.push({ message }),
    exit: (exit, note) => void events.push({ exit, note }),
  };
  const target = await WorkerdTarget.launch(handlers, { executable: WORKERD, cwd });
  t.after(() => target.kill());
  const run = (cell: string) => target.evaluate(target.transform(cell, {}));
  return { target, events, run };
}

test("launch reports workerd's date and engine", { skip }, async (t) => {
  const { target } = await launch(t);
  assert.match(target.versions.runtime, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(target.versions.engine, /^V8/);
});

test("cells run inside a request: timers, randomness and globals that persist", { skip }, async (t) => {
  const { target, run } = await launch(t);
  await run("const a: number = 40");
  await run("await new Promise((r) => setTimeout(r, 5)); globalThis.n = crypto.randomUUID().length");
  const { result } = await run("a + 2 + n");
  assert.equal(result.type, "number");
  assert.ok((await target.propertyNames("globalThis")).includes("a"));
});

test("console output and display messages arrive in order", { skip }, async (t) => {
  const { events, run } = await launch(t);
  await run('console.log("before"); await jupyter.display(jupyter.md`mid`); console.error("after")');
  const order = events.flatMap((e) =>
    "stream" in e ? [`${e.stream}:${e.text}`] : "message" in e && e.message.kind === "iopub" ? [e.message.msg_type] : []
  );
  assert.deepEqual(order, ["stdout:before\n", "display_data", "stderr:after\n"]);
});

test("a relative import is bundled by the host", { skip }, async (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, "data.ts"), "export const answer: number = 42;\n");
  const { target, run } = await launch(t, dir);
  const { result, exceptionDetails } = await run('import { answer } from "./data.ts"; answer');
  assert.equal(exceptionDetails, undefined);
  assert.equal(result.type, "number");
  const missing = await run('import "./nope.ts"');
  assert.ok(missing.exceptionDetails?.exception);
  assert.match((await target.describeError(missing.exceptionDetails.exception)).message, /Cannot import "\.\/nope\.ts"/);
});

test("I/O objects and pending work carry over between cells: one session", { skip }, async (t) => {
  const { events, run } = await launch(t);
  // A Response body is an I/O object, tied to the request that made it.
  await run("globalThis.res = new Response('body text')");
  const read = await run("await res.text()");
  assert.equal(read.exceptionDetails, undefined, "read in a later cell");
  await run("setTimeout(() => console.log('later'), 100)");
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(events.some((e) => "stream" in e && e.text === "later\n"), "a timer outlives its cell");
});

test("a cell waiting on nothing is interrupted in place", { skip }, async (t) => {
  const { target, run } = await launch(t);
  await run("globalThis.kept = 1");
  const pending = run("await new Promise(() => {})");
  await new Promise((r) => setTimeout(r, 200));
  await target.interrupt();
  await assert.rejects(pending, Interrupted);
  assert.equal((await run("kept")).result.type, "number");
});

test("interrupting a waiting cell cancels it and keeps state", { skip }, async (t) => {
  const { target, events, run } = await launch(t);
  await run("globalThis.kept = 1");
  const pending = run("await new Promise((r) => setTimeout(r, 60_000))");
  await new Promise((r) => setTimeout(r, 200));
  await target.interrupt();
  await assert.rejects(pending, Interrupted);
  assert.equal((await run("kept")).result.type, "number");
  assert.ok(!events.some((e) => "exit" in e));
});

test("interrupting a busy cell stops workerd, reporting the exit before the cell fails", { skip }, async (t) => {
  const { target, events, run } = await launch(t);
  const pending = run("while (true) {}");
  await new Promise((r) => setTimeout(r, 200));
  let exitedFirst = false;
  const outcome = pending.catch((err: unknown) => {
    exitedFirst = events.some((e) => "exit" in e);
    return err;
  });
  await target.interrupt();
  assert.ok((await outcome) instanceof Interrupted);
  assert.ok(exitedFirst, "the restart note is published inside the cell");
  assert.deepEqual(events.find((e) => "exit" in e), { exit: null, note: RESTART_NOTE });
});

test("comm messages reach registered targets inside a request", { skip }, async (t) => {
  const { target, run } = await launch(t);
  await run('jupyter.comm.registerTarget("t", (comm) => comm.onMsg(() => setTimeout(() => {}, 1)))');
  assert.deepEqual(await target.dispatchComm("comm_open", { comm_id: "c1", target_name: "t", data: {} }, {}, []), {
    handled: true,
  });
  assert.deepEqual(await target.dispatchComm("comm_msg", { comm_id: "c1", data: {} }, {}, []), { handled: true });
});
