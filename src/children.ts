// Runtimes this process started, killed when it exits however it exits
// short of SIGKILL: a target left behind keeps running, reparented to pid 1,
// with whatever temp directory it uses (#127, #218).
import process from "node:process";
import type { ChildProcess } from "node:child_process";

const cleanups = new Set<() => void>();

function runAll(): void {
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // Best effort: the process is exiting.
    }
  }
  cleanups.clear();
}

let hooked = false;

/**
 * Kills `child` if it's still running when this process exits. `cleanup`
 * replaces the default SIGKILL; it must be synchronous, as exit hooks are,
 * and do whatever the child's own exit listener would have done.
 */
export function killOnExit(child: ChildProcess, cleanup: () => void = () => child.kill("SIGKILL")): void {
  if (!hooked) {
    hooked = true;
    process.on("exit", runAll);
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  cleanups.add(cleanup);
  child.once("exit", () => cleanups.delete(cleanup));
}
