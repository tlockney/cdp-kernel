// A target that fails or stalls while starting is stopped, so it can't keep
// the host (or a test file) running (#52).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Target, type TargetEvents } from "../src/target.ts";

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
