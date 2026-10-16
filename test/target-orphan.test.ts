// A Node or Deno runtime exits once its host is gone, even when the host
// was SIGKILLed and ran no cleanup (#127, #219).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET = fileURLToPath(new URL("../src/target.ts", import.meta.url));
const hasDeno = spawnSync("deno", ["--version"]).status === 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const runtime of ["node", "deno"] as const) {
  test(`a ${runtime} target exits when its host is SIGKILLed`, {
    skip: process.platform === "win32" ? "no pgrep" : runtime === "deno" && !hasDeno ? "deno not on PATH" : false,
  }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "cdpk-orphan-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const host = join(dir, "host.ts");
    writeFileSync(
      host,
      `import { Target } from ${JSON.stringify(TARGET)};\n` +
        `await Target.launch(${JSON.stringify(runtime)}, { stream() {}, message() {}, exit() {} });\n` +
        `console.log("ready");\n`,
    );
    const child = spawn(process.execPath, [host], { stdio: ["ignore", "pipe", "inherit"] });
    t.after(() => child.kill("SIGKILL"));
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk: Buffer) => chunk.toString().includes("ready") && resolve());
      child.once("exit", (code) => reject(new Error(`host exited (${code})`)));
    });
    const [pid] = execFileSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" }).split(/\s+/).filter(Boolean).map(Number);
    t.after(() => {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    });
    child.kill("SIGKILL");
    for (let i = 0; i < 200 && alive(pid); i++) await sleep(25);
    assert.equal(alive(pid), false, `${runtime} target ${pid} outlived its host`);
  });
}
