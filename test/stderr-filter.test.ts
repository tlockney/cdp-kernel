import { test } from "node:test";
import assert from "node:assert/strict";
import { StderrFilter } from "../src/target.ts";

function run(runtime: "node" | "deno", chunks: string[], flush = false): string[] {
  const out: string[] = [];
  const filter = new StderrFilter(runtime, (text) => void out.push(text));
  for (const chunk of chunks) filter.push(chunk);
  if (flush) filter.flush();
  return out;
}

test("StderrFilter drops whole inspector notices and keeps other lines", () => {
  const out = run("node", [
    "Debugger listening on ws://127.0.0.1:1/x\nFor help, see: https://nodejs.org/learn/getting-started/debugging\nboom\n",
    "Debugger attached.\n",
    "Waiting for the debugger to disconnect...\n",
  ]);
  assert.equal(out.join(""), "boom\n");
});

test("StderrFilter drops a notice split across chunks", () => {
  const out = run("deno", ["Visit chrome://in", "spect to connect to the debugger.\nafter\n"]);
  assert.equal(out.join(""), "after\n");
  const colored = run("deno", ["\x1b[32mDownload\x1b[0m https://jsr.io/@std/a", "ssert/meta.json\n"]);
  assert.equal(colored.join(""), "");
  const cutEscape = run("deno", ["\x1b[3", "2mDownload\x1b[0m https://jsr.io/x\n"]);
  assert.equal(cutEscape.join(""), "");
});

test("StderrFilter drops Deno's notice for each inspector session (#281)", () => {
  assert.equal(run("deno", ["Debugger session started.\nDebugger session started.\nasdf\n"]).join(""), "asdf\n");
});

test("StderrFilter keeps Download lines on Node", () => {
  assert.equal(run("node", ["Download https://x\n"]).join(""), "Download https://x\n");
});

test("StderrFilter keeps a user line that only starts like a notice", () => {
  assert.equal(run("deno", ["For help, see: the docs\n"]).join(""), "For help, see: the docs\n");
  assert.equal(run("deno", ["Down", "stream failed\n"]).join(""), "Downstream failed\n");
});

test("StderrFilter passes partial lines through unless they could be a notice", () => {
  assert.deepEqual(run("node", ["progress 1", " 2", "\n"]), ["progress 1", " 2", "\n"]);
  // The rest of a line already sent is never mistaken for a notice.
  assert.equal(run("deno", ["x: ", "Download https://y\n"]).join(""), "x: Download https://y\n");
});

test("StderrFilter flush releases a held partial line", () => {
  assert.deepEqual(run("node", ["Debugger"]), []);
  assert.deepEqual(run("node", ["Debugger"], true), ["Debugger"]);
});

test("StderrFilter never holds or drops a barrier marker", () => {
  const marker = "\x1b[cdpk:3m]\x1b";
  assert.equal(run("node", ["Debugger attached." + marker + "\n"]).join(""), "Debugger attached." + marker + "\n");
  assert.equal(run("node", ["Debugger listening on " + marker]).join(""), "Debugger listening on " + marker);
  assert.equal(run("node", ["Debugger \x1b[", "cdpk:3]\x1b"]).join(""), "Debugger \x1b[cdpk:3]\x1b");
});
