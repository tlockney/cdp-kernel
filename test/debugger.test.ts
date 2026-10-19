// The Jupyter debugger protocol (#18) against real Node and Deno targets,
// driven as JupyterLab drives it. test/e2e.py covers it through the kernel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DapMessage, type DebugChannel, Debugger, HASH_SEED } from "../src/debugger.ts";
import { murmur2 } from "../src/murmur2.ts";
import { Target, type TargetEvents } from "../src/target.ts";
import type { EvaluateResult } from "../src/cdp.ts";
import { loadTypeStripper } from "../src/transform.ts";

await loadTypeStripper("esbuild");

const hasDeno = spawnSync("deno", ["--version"], { stdio: "ignore" }).status === 0;
/** A step that takes longer has stalled: fail it with what the target was doing, not at the file's timeout. */
const STEP_TIMEOUT = 30_000;

async function session(t: { after(fn: () => void): void }, runtime: "node" | "deno") {
  const events: TargetEvents = { stream: () => {}, message: () => {}, exit: () => {} };
  const target = await Target.launch(runtime, events);
  t.after(() => target.kill());
  const dap: DapMessage[] = [];
  let waiters: { event: string; resolve: (e: DapMessage) => void }[] = [];
  const dbg = new Debugger((event) => {
    dap.push(event);
    waiters = waiters.filter((w) => (w.event === event.event ? (w.resolve(event), false) : true));
  });
  // Every pause, where it stopped: a step that stalls says why (#292).
  const urls = new Map<string, string>();
  const pauses: string[] = [];
  target.debug.on("Debugger.scriptParsed", (p) => void urls.set(String(p.scriptId), String(p.url)));
  target.debug.on("Debugger.paused", (p) => {
    const frames = (p.callFrames as { functionName: string; location: { scriptId: string; lineNumber: number } }[])
      .slice(0, 6)
      .map((f) => `${f.functionName || "(anonymous)"} ${urls.get(f.location.scriptId) || "(no url)"}:${f.location.lineNumber + 1}`);
    const data = p.data as { description?: string } | undefined;
    pauses.push(`${String(p.reason)}${data?.description ? ` (${data.description.split("\n")[0]})` : ""}: ${frames.join(" < ")}`);
  });
  await dbg.attachTarget(target.debug);
  const within = async <T>(what: string, promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
      // Not target.diagnose(): its probe pause and resume would let a
      // paused target go, and hide what held it.
      timer = setTimeout(() =>
        reject(new Error([
          `${what}: no answer in ${STEP_TIMEOUT / 1000} s${dbg.stopped ? ", target paused" : ""}`,
          `DAP events: ${dap.map((e) => e.event).join(", ") || "none"}`,
          `pauses:${pauses.map((p) => `\n  ${p}`).join("") || " none"}`,
        ].join("\n"))), STEP_TIMEOUT);
    });
    try {
      return await Promise.race([promise, stalled]);
    } finally {
      clearTimeout(timer);
    }
  };
  let seq = 0;
  const request = async (command: string, args: DapMessage = {}) => {
    const reply = await within(command, dbg.handle({ type: "request", seq: ++seq, command, arguments: args }));
    assert.equal(reply.success, true, `${command}: ${String(reply.message)}`);
    return reply.body as DapMessage;
  };
  const next = (event: string) => within(`waiting for ${event}`, new Promise<DapMessage>((resolve) => waiters.push({ event, resolve })));
  /** Runs a cell as the kernel does while debugging. */
  const run = (code: string): Promise<EvaluateResult> =>
    within(`running ${JSON.stringify(code)}`, dbg.started ? target.evaluate(dbg.cellScript(code, code)) : target.evaluate(target.transform(code, {})));
  return { target, dbg, dap, request, next, run, within };
}

const CELL = [
  "const a: number = 1;", //  line 1
  "interface Unused { x: number }", // 2
  "const b = a + 1;", //      line 3
  "const c = b * 2;", //      line 4
  "c", //                     line 5
].join("\n");

test("inspectVariables gives up when the target pauses during it, so later requests aren't held up", async () => {
  // A global evaluation sent just before a breakpoint hits doesn't finish
  // while the target is paused (seen on Deno in test/lab_widgets.py).
  const listeners = new Map<string, ((p: DapMessage) => void)[]>();
  let evaluations = 0;
  const channel: DebugChannel = {
    send: (method) => {
      if (method === "Runtime.evaluate" || method === "Runtime.globalLexicalScopeNames") {
        evaluations++;
        return new Promise(() => {}); // never answers, as while paused
      }
      return Promise.resolve({});
    },
    on: (method, listener) => void listeners.set(method, [...(listeners.get(method) ?? []), listener]),
    contextId: 1,
    baselineGlobals: new Set(),
  };
  const dbg = new Debugger(() => {});
  await dbg.attachTarget(channel);
  await dbg.handle({ type: "request", seq: 1, command: "attach" });
  const pending = dbg.handle({ type: "request", seq: 2, command: "inspectVariables" });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(evaluations > 0, "the evaluation is in flight");
  for (const listener of listeners.get("Debugger.paused") ?? []) listener({ callFrames: [], reason: "other" });
  const reply = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), 1000))]);
  assert.ok(reply, "inspectVariables answered after the pause");
  assert.deepEqual(reply.body, { variables: [] });
});

for (const runtime of ["node", "deno"] as const) {
  const skip = runtime === "deno" && !hasDeno;

  test(`${runtime}: breakpoints, frames, scopes, variables, stepping and continue`, { skip }, async (t) => {
    const { dbg, dap, request, next, run } = await session(t, runtime);
    const info = await request("debugInfo");
    assert.equal(info.isStarted, false);
    assert.equal(info.hashMethod, "Murmur2");
    assert.equal(info.hashSeed, HASH_SEED);
    const capabilities = await request("initialize", { clientID: "jupyterlab", linesStartAt1: true });
    assert.ok(Array.isArray(capabilities.exceptionBreakpointFilters));
    await request("attach");
    assert.equal((await request("debugInfo")).isStarted, true);
    assert.ok(dap.some((e) => e.event === "initialized"));

    // The path is JupyterLab's own: prefix + murmur2(code) + suffix.
    const { sourcePath } = await request("dumpCell", { code: CELL });
    assert.equal(sourcePath, `${info.tmpFilePrefix}${murmur2(CELL, HASH_SEED)}${info.tmpFileSuffix}`);
    assert.equal(readFileSync(String(sourcePath), "utf8"), CELL);
    const set = await request("setBreakpoints", { source: { path: sourcePath }, breakpoints: [{ line: 3 }] });
    assert.deepEqual((set.breakpoints as DapMessage[]).map((b) => [b.verified, b.line]), [[true, 3]]);

    const stopped = next("stopped");
    const result = run(CELL);
    const event = await stopped;
    assert.deepEqual(event.body, { reason: "breakpoint", threadId: 1, allThreadsStopped: true });
    assert.equal(dbg.stopped, true);
    assert.deepEqual((await request("debugInfo")).stoppedThreads, [1]);

    const { stackFrames } = await request("stackTrace", { threadId: 1 });
    const top = (stackFrames as DapMessage[])[0];
    assert.equal(top.line, 3, "the cell's own line, through the TypeScript transform");
    assert.deepEqual(top.source, { path: sourcePath });
    assert.equal(top.name, "<cell>");
    assert.equal((stackFrames as DapMessage[]).length, 1, "the kernel's and the runtime's frames are left out");

    const { scopes } = await request("scopes", { frameId: top.id });
    const script = (scopes as DapMessage[]).find((s) => s.name === "Script");
    assert.ok(script, `scopes: ${JSON.stringify(scopes)}`);
    const { variables } = await request("variables", { variablesReference: script.variablesReference });
    const byName = new Map((variables as DapMessage[]).map((v) => [v.name, v.value]));
    assert.equal(byName.get("a"), "1");
    assert.ok(!byName.has("__cdpk"));

    assert.equal((await request("evaluate", { expression: "a + 41", frameId: top.id, context: "repl" })).result, "42");
    const rich = await request("richInspectVariables", { variableName: "a", frameId: top.id });
    assert.match(String((rich.data as DapMessage)["text/plain"]), /1/);

    const stepped = next("stopped");
    await request("next", { threadId: 1 });
    await stepped;
    const after = (await request("stackTrace", { threadId: 1 })).stackFrames as DapMessage[];
    assert.equal(after[0].line, 4, "next moves to the cell's next line");

    const continued = next("continued");
    await request("continue", { threadId: 1 });
    await continued;
    assert.equal((await result).result.value, 4);
    assert.equal(dbg.stopped, false);

    // The variable explorer between cells: what the cells defined.
    const globals = (await request("inspectVariables")).variables as DapMessage[];
    const names = globals.map((v) => v.name);
    assert.ok(["a", "b", "c"].every((n) => names.includes(n)), names.join());
    assert.ok(!names.some((n) => ["jupyter", "__cdpk", "prompt", "setTimeout", "console"].includes(String(n))), names.join());
    assert.equal(globals.find((v) => v.name === "c")?.value, "4");
  });

  test(`${runtime}: requests JupyterLab sends while stopped answer promptly`, { skip }, async (t) => {
    // JupyterLab asks for the globals on every iopub message, the stopped
    // event's included; a global evaluation can't finish while paused, and
    // it once held up every request after it (found by test/lab_widgets.py).
    const { request, next, run } = await session(t, runtime);
    await request("initialize");
    await request("attach");
    const code = "const k = 5;\nk * 2";
    await request("setBreakpoints", { source: { path: (await request("dumpCell", { code })).sourcePath }, breakpoints: [{ line: 2 }] });
    const stopped = next("stopped");
    const result = run(code);
    await stopped;
    const quick = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("hung")), 3000))]);
    assert.deepEqual((await quick(request("inspectVariables"))).variables, []);
    assert.deepEqual(await quick(request("modules")), { modules: [], totalModules: 0 }, "JupyterLab treats a failure here as fatal");
    const rich = await quick(request("richInspectVariables", { variableName: "k" }));
    assert.match(String((rich.data as DapMessage)["text/plain"]), /5/, "a frameless request uses the top frame");
    assert.ok(((await quick(request("stackTrace", { threadId: 1 }))).stackFrames as DapMessage[]).length > 0);
    await request("continue", { threadId: 1 });
    assert.equal((await result).result.value, 10);
  });

  test(`${runtime}: pause on exceptions, then disconnect stops pausing`, { skip }, async (t) => {
    const { dbg, request, next, run } = await session(t, runtime);
    await request("initialize");
    await request("attach");
    await request("setExceptionBreakpoints", { filters: ["caught"] });
    const code = "throw new RangeError('stop here')";
    const stopped = next("stopped");
    const result = run(code);
    assert.equal(((await stopped).body as DapMessage).reason, "exception");
    await request("continue", { threadId: 1 });
    assert.ok((await result).exceptionDetails, "the cell still fails, as it would undebugged");

    const path = dbg.pathFor("const z = 1;\nz");
    await request("setBreakpoints", { source: { path }, breakpoints: [{ line: 2 }] });
    await request("disconnect", { restart: false, terminateDebuggee: false });
    assert.equal((await request("debugInfo")).isStarted, false);
    assert.equal((await run("const z = 1;\nz")).result.value, 1, "no breakpoint fires after disconnect");
  });

  test(`${runtime}: an exception the runtime throws and catches in its own code doesn't pause`, { skip }, async (t) => {
    // Deno's lazy node_options setup throws and catches in ext: code; that
    // pause came before the cell's and held it (#380). A script named like
    // the runtime's own stands in for it.
    const { target, dap, request, next, run } = await session(t, runtime);
    const builtin = runtime === "deno" ? "ext:cdpk_test/internal.js" : "node:cdpk_test/internal";
    await target.evaluate(`globalThis.internal = () => { try { throw new Error("internal") } catch { return 1 } };\nglobalThis.fails = () => { throw new Error("fails") };\n//# sourceURL=${builtin}`);
    await request("initialize");
    await request("attach");
    await request("setExceptionBreakpoints", { filters: ["caught"] });
    assert.equal((await run("internal() + 1")).result.value, 2);
    assert.ok(!dap.some((e) => e.event === "stopped"), "nothing paused");
    // An exception from the runtime that the cell catches still pauses.
    const stopped = next("stopped");
    const result = run("try { fails() } catch {}\n3");
    assert.equal(((await stopped).body as DapMessage).reason, "exception");
    await request("continue", { threadId: 1 });
    assert.equal((await result).result.value, 3);
  });

  test(`${runtime}: with caught exceptions on, the kernel's own evaluations don't pause the target`, { skip }, async (t) => {
    // A pause inside a call the inspector dispatches held it on Node, and
    // left Deno's event loop stopped for good: no later cell ran (#307).
    const { dbg, dap, request, next, run, within } = await session(t, runtime);
    await request("initialize");
    await request("attach");
    await request("setExceptionBreakpoints", { filters: ["caught"] });
    await run("const big = { toString() { throw new Error('no text') } };");
    const typo = await within("evaluate", dbg.handle({ type: "request", seq: 100, command: "evaluate", arguments: { expression: "notDefinedAnywhere", context: "repl" } }));
    assert.equal(typo.success, false);
    assert.match(String(typo.message), /notDefinedAnywhere is not defined/);
    assert.ok((await request("richInspectVariables", { variableName: "big" })).data);
    assert.ok(!dap.some((e) => e.event === "stopped"), "nothing paused");
    assert.equal((await run("1 + 1")).result.value, 2, "cells still run");
    // And a cell's own exception still pauses.
    const stopped = next("stopped");
    const result = run("try { throw 1 } catch {}\n3");
    assert.equal(((await stopped).body as DapMessage).reason, "exception");
    await request("continue", { threadId: 1 });
    assert.equal((await result).result.value, 3);
  });

  test(`${runtime}: unknown commands fail, and source serves dumped cells`, { skip }, async (t) => {
    const { dbg, request } = await session(t, runtime);
    const bad = await dbg.handle({ type: "request", seq: 1, command: "frobnicate" });
    assert.equal(bad.success, false);
    assert.match(String(bad.message), /unsupported debug command: frobnicate/);
    const { sourcePath } = await request("dumpCell", { code: "1 + 1" });
    assert.equal((await request("source", { source: { path: sourcePath } })).content, "1 + 1");
  });
}

test("the debugger's cell files are removed when the kernel exits", () => {
  const script = `
    import { existsSync } from "node:fs";
    import { Debugger } from ${JSON.stringify(new URL("../src/debugger.ts", import.meta.url).href)};
    import { loadTypeStripper } from ${JSON.stringify(new URL("../src/transform.ts", import.meta.url).href)};
    await loadTypeStripper("esbuild");
    const dbg = new Debugger(() => {});
    dbg.cellScript("1 + 1", "1 + 1");
    if (!existsSync(dbg.pathFor("1 + 1"))) throw new Error("no cell file");
    console.log(dbg.prefix);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const prefix = child.stdout.trim();
  assert.ok(prefix.includes("cdp-kernel_"));
  assert.equal(existsSync(prefix), false);
});

test("the debugger writes no cell file into a directory it doesn't own privately", { skip: process.platform === "win32" }, (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "cdpk-dbg-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const victim = join(scratch, "victim");
  writeFileSync(victim, "untouched");
  // Another user's directory at the predictable path, with a symlink where
  // the cell's file goes.
  const script = `
    import { chmodSync, mkdirSync, symlinkSync } from "node:fs";
    import { Debugger } from ${JSON.stringify(new URL("../src/debugger.ts", import.meta.url).href)};
    import { loadTypeStripper } from ${JSON.stringify(new URL("../src/transform.ts", import.meta.url).href)};
    await loadTypeStripper("esbuild");
    const dbg = new Debugger(() => {});
    mkdirSync(dbg.prefix);
    chmodSync(dbg.prefix, 0o777);
    symlinkSync(${JSON.stringify(victim)}, dbg.pathFor("1 + 1"));
    dbg.cellScript("1 + 1", "1 + 1");
    console.log(dbg.prefix);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const prefix = child.stdout.trim();
  t.after(() => rmSync(prefix, { recursive: true, force: true }));
  assert.equal(readFileSync(victim, "utf8"), "untouched");
  assert.ok(existsSync(prefix), "a directory that isn't the kernel's is left at exit");
});
