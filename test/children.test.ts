// Runtimes don't outlive the kernel when it exits by SIGTERM, SIGHUP or an
// uncaught error, even mid-start (#127, #218).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MAIN = join(REPO, "src", "main.ts");
const linux = process.platform === "linux";
const has = (cmd: string) => spawnSync(cmd, ["--version"]).status === 0;

function childrenOf(pid: number): number[] {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Waits for `pid` to have a child matching `match`, returning its pid. */
async function runtimeOf(pid: number, match: RegExp): Promise<number> {
  for (let i = 0; i < 400; i++) {
    for (const child of childrenOf(pid)) {
      const cmdline = (() => {
        try {
          return execFileSync("ps", ["-o", "args=", "-p", String(child)], { encoding: "utf8" });
        } catch {
          return "";
        }
      })();
      if (match.test(cmdline)) return child;
    }
    await sleep(25);
  }
  throw new Error(`no runtime matching ${match} under ${pid}`);
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 120 && alive(pid); i++) await sleep(25);
  return !alive(pid);
}

const runtimes = [
  { runtime: "node", match: /bootstrap\.mjs/, available: true },
  { runtime: "deno", match: /bootstrap\.mjs/, available: has("deno") },
  { runtime: "bun", match: /bootstrap\.mjs/, available: has("bun") },
  { runtime: "workerd", match: /workerd serve/, available: existsSync(join(REPO, "node_modules", ".bin", "workerd")) },
] as const;

for (const { runtime, match, available } of runtimes) {
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    test(`${signal} to the kernel stops its ${runtime} runtime`, { skip: !linux || !available }, async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "cdpk-children-"));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const kernel = spawn(process.execPath, [MAIN, "kernel", "--runtime", runtime, "--conn", await connectionFile(dir)], {
        cwd: REPO,
        stdio: "ignore",
      });
      t.after(() => kernel.kill("SIGKILL"));
      const pid = await runtimeOf(kernel.pid!, match);
      // workerd runs in its temp directory, which goes with it.
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      kernel.kill(signal);
      assert.ok(await gone(pid), `${runtime} (${pid}) still running`);
      if (runtime === "workerd") assert.ok(!existsSync(cwd), `${cwd} left behind`);
    });
  }
}

test("a host that dies of an uncaught error mid-start stops the starting runtime", { skip: !linux }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cdpk-children-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = join(dir, "pid");
  // A runtime still starting: it never prints its inspector URL.
  const fake = join(dir, "fake-node");
  writeFileSync(fake, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 60\n`);
  chmodSync(fake, 0o755);
  const host = join(dir, "host.ts");
  writeFileSync(
    host,
    `import { Target } from ${JSON.stringify(join(REPO, "src", "target.ts"))};\n` +
      `void Target.launch("node", { stream() {}, message() {}, exit() {} }, { executable: ${JSON.stringify(fake)} });\n` +
      `setTimeout(() => { throw new Error("boom"); }, 500);\n`,
  );
  const child = spawn(process.execPath, [host], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 1, "the host died of its error");
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(await gone(pid), `runtime (${pid}) still running`);
});
