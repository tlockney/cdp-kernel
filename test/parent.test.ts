// A kernel exits, and stops its runtime, once the server named by
// JPY_PARENT_PID is gone, even when the server was SIGKILLed (#254).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MAIN = join(REPO, "src", "main.ts");
const skip = process.platform !== "linux" ? "needs pgrep and /bin/sh" : false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function connectionFile(dir: string): Promise<string> {
  const ports = { shell_port: 0, control_port: 0, stdin_port: 0, iopub_port: 0, hb_port: 0 };
  for (const name of Object.keys(ports) as (keyof typeof ports)[]) ports[name] = await freePort();
  const path = join(dir, "conn.json");
  writeFileSync(path, JSON.stringify({ ...ports, ip: "127.0.0.1", key: "", transport: "tcp", signature_scheme: "hmac-sha256" }));
  return path;
}

/**
 * A stand-in server: a shell that starts the kernel in the background with
 * JPY_PARENT_PID set to `parent` (its own pid when "self", unset when null)
 * and waits. Returns the shell, the kernel's pid and its runtime's pid.
 */
async function startKernel(t: { after(fn: () => void): void }, parent: "self" | number | null) {
  const dir = mkdtempSync(join(tmpdir(), "cdpk-parent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = parent === null ? "unset JPY_PARENT_PID" : `export JPY_PARENT_PID=${parent === "self" ? "$$" : parent}`;
  const script = `${env}\n"$0" "$1" kernel --runtime node --conn "$2" </dev/null >/dev/null 2>&1 &\necho $!\nwait\n`;
  const server = spawn("/bin/sh", ["-c", script, process.execPath, MAIN, await connectionFile(dir)], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => server.kill("SIGKILL"));
  const kernel = await new Promise<number>((resolve, reject) => {
    server.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    server.once("exit", (code) => reject(new Error(`server exited (${code})`)));
  });
  t.after(() => {
    if (alive(kernel)) process.kill(kernel, "SIGKILL");
  });
  let runtime = 0;
  for (let i = 0; i < 400 && !runtime; i++) {
    try {
      runtime = Number(execFileSync("pgrep", ["-P", String(kernel), "-f", "bootstrap"], { encoding: "utf8" }).split(/\s+/)[0]);
    } catch {
      await sleep(25);
    }
  }
  assert.ok(runtime, "the kernel started no runtime");
  t.after(() => {
    if (alive(runtime)) process.kill(runtime, "SIGKILL");
  });
  return { server, kernel, runtime };
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 200 && alive(pid); i++) await sleep(25);
  return !alive(pid);
}

test("a kernel exits with its runtime when its server is SIGKILLed", { skip }, async (t) => {
  const { server, kernel, runtime } = await startKernel(t, "self");
  server.kill("SIGKILL");
  assert.ok(await gone(kernel), `kernel ${kernel} outlived its server`);
  assert.ok(await gone(runtime), `runtime ${runtime} outlived its kernel`);
});

test("a kernel exits when JPY_PARENT_PID's process exits, though its own parent runs on", { skip }, async (t) => {
  // The server behind a launcher: the kernel's parent isn't JPY_PARENT_PID.
  const server = spawn("sleep", ["60"], { stdio: "ignore" });
  t.after(() => server.kill("SIGKILL"));
  const { kernel } = await startKernel(t, server.pid!);
  server.kill("SIGKILL");
  assert.ok(await gone(kernel), `kernel ${kernel} outlived JPY_PARENT_PID`);
});

test("without JPY_PARENT_PID, a kernel keeps running when its parent exits", { skip }, async (t) => {
  const { server, kernel } = await startKernel(t, null);
  server.kill("SIGKILL");
  await sleep(2500);
  assert.ok(alive(kernel), "a kernel started by hand exited");
});
