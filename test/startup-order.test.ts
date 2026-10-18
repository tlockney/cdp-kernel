// The runtime starts only once the kernel has bound all five ports. A Deno
// runtime binds its inspector to port 0 within milliseconds, and could take a
// connection-file port the kernel hadn't bound yet (#257).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "./ports.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MAIN = join(REPO, "src", "main.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runtimes(pid: number): number[] {
  try {
    return execFileSync("pgrep", ["-P", String(pid), "-f", "bootstrap"], { encoding: "utf8" }).split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function listen(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

test("the runtime starts after the kernel's ports are bound", { skip: process.platform !== "linux" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cdpk-order-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ports: number[] = [];
  for (let i = 0; i < 5; i++) ports.push(await freePort());
  // The control port is taken while the kernel starts.
  const held = await listen(ports[1]);
  t.after(() => held.close());
  const conn = join(dir, "conn.json");
  writeFileSync(conn, JSON.stringify({
    shell_port: ports[0], control_port: ports[1], stdin_port: ports[2], iopub_port: ports[3], hb_port: ports[4],
    ip: "127.0.0.1", key: "", transport: "tcp", signature_scheme: "hmac-sha256",
  }));
  const kernel = spawn(process.execPath, [MAIN, "kernel", "--runtime", "node", "--conn", conn], { cwd: REPO, stdio: "ignore" });
  t.after(() => kernel.kill("SIGKILL"));
  await sleep(1500);
  assert.deepEqual(runtimes(kernel.pid!), [], "a runtime started while a port was still taken");
  await new Promise((resolve) => held.close(resolve));
  let started: number[] = [];
  for (let i = 0; i < 200 && started.length === 0; i++) {
    await sleep(25);
    started = runtimes(kernel.pid!);
  }
  assert.equal(started.length, 1, "no runtime once the port came free");
});
