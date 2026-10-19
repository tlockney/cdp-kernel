// A target that fails or stalls while starting is stopped, so it can't keep
// the host (or a test file) running (#52).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Target, type TargetEvents } from "../src/target.ts";
import { BunTarget } from "../src/bun-target.ts";
import { type WorkerHost, WorkerdTarget } from "../src/workerd-target.ts";

const events: TargetEvents = { stream: () => {}, message: () => {}, exit: () => {} };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a target whose inspector never comes up is stopped when the start times out", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cdpk-start-"));
  const pidFile = join(dir, "pid");
  const fake = join(dir, "fake-node");
  // Stands in for a runtime that hangs before printing its inspector URL.
  writeFileSync(fake, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 60\n`);
  chmodSync(fake, 0o755);

  await assert.rejects(
    Target.launch("node", events, { executable: fake, startTimeoutMs: 500 }),
    /did not start within 0.5s/,
  );
  const pid = Number(readFileSync(pidFile, "utf8"));
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(alive(pid), false, "the stalled runtime was killed");
});

test("a target whose bootstrap never installs the shim is stopped when the start times out", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cdpk-start-"));
  const pidFile = join(dir, "pid");
  const fake = join(dir, "fake-node");
  // A real inspector, but a script that never defines __cdpk: the probe loop
  // used to give up after 5 s and return a target every cell fails on (#134).
  writeFileSync(
    fake,
    `#!/bin/sh\necho $$ > "${pidFile}"\nexec "${process.execPath}" --inspect=127.0.0.1:0 --inspect-publish-uid=stderr -e "setInterval(() => {}, 1000)"\n`,
  );
  chmodSync(fake, 0o755);

  await assert.rejects(
    Target.launch("node", events, { executable: fake, startTimeoutMs: 6_000 }),
    /did not start within 6s/,
  );
  const pid = Number(readFileSync(pidFile, "utf8"));
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(alive(pid), false, "the stalled runtime was killed");
});

test("a bun target that never becomes ready is stopped when the start times out", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cdpk-start-"));
  const pidFile = join(dir, "pid");
  const fake = join(dir, "fake-bun");
  // Stays up but never says it's ready on its channel (#336).
  writeFileSync(fake, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 60\n`);
  chmodSync(fake, 0o755);

  await assert.rejects(BunTarget.launch(events, { executable: fake, startTimeoutMs: 500 }), /did not start within 0.5s/);
  const pid = Number(readFileSync(pidFile, "utf8"));
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(alive(pid), false, "the stalled runtime was killed");
});

test("a workerd driver that never answers is stopped when the start times out", async () => {
  let stopped = false;
  // A session that is open but never replies (#336).
  const host: WorkerHost = {
    runtime: "workerd test",
    channel: { send: () => {}, onMessage: () => {}, onClose: () => {}, close: () => {} },
    stop: () => void (stopped = true),
    onExit: () => {},
  };
  await assert.rejects(
    WorkerdTarget.open(host, tmpdir(), events, "workerd", { startTimeoutMs: 200 }),
    /the workerd driver did not start within 0.2s/,
  );
  assert.equal(stopped, true, "the host was stopped");
});
