// Runtimes this process started, killed when it exits however it exits
// short of SIGKILL: a target left behind keeps running, reparented to pid 1,
// with whatever temp directory it uses (#127, #218).
//
// SIGKILL runs no exit hook, so a helper outside this process also knows the
// runtimes' pids (#240): a detached sh reading this process's pipe, which
// kills whatever is still registered, and removes the registered temp
// directories, once the pipe closes. That covers what nothing in a runtime
// can notice: celld dev and its server, and a Node or Deno runtime stuck in
// a cell's synchronous loop, where the #219 watchdog never gets to run.
import process from "node:process";
import { type ChildProcess, spawn } from "node:child_process";

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
 * The helper's script. Lines on stdin: `+pid` registers a pid, `-pid`
 * forgets it (it exited, and the pid may be reused), `d<path>` registers a
 * directory. In its own session, so a killpg of this process's group (as
 * Jupyter's kill does) doesn't take it down first.
 */
export const REAPER_SCRIPT = `trap '' HUP INT
pids=" "
dirs=""
while IFS= read -r line; do
  case $line in
    +*) pids="$pids\${line#?} " ;;
    -*) pids=$(printf '%s' "$pids" | sed "s/ \${line#?} / /") ;;
    d*) dirs="$dirs\${line#?}
" ;;
  esac
done
kill -9 $pids 2>/dev/null
printf '%s' "$dirs" | while IFS= read -r dir; do rm -rf -- "$dir"; done
`;

let reaper: ChildProcess | null | undefined;

/** Sends `line` to the helper, starting it first; a no-op on Windows. */
function tellReaper(line: string): void {
  if (reaper === undefined) {
    reaper = null;
    if (process.platform === "win32") return;
    try {
      const child = spawn("/bin/sh", ["-c", REAPER_SCRIPT], { cwd: "/", detached: true, stdio: ["pipe", "ignore", "ignore"] });
      child.once("error", () => (reaper = null));
      child.stdin?.on("error", () => (reaper = null));
      // Neither the helper nor its pipe keeps this process running.
      child.unref();
      (child.stdin as { unref?: () => void } | null)?.unref?.();
      reaper = child;
    } catch {
      return;
    }
  }
  reaper?.stdin?.write(`${line}\n`);
}

/**
 * Kills `pid`, which isn't this process's child (a runtime's own child in
 * its own process group), if this process dies while `owner` runs.
 */
export function reapWith(pid: number, owner: ChildProcess): void {
  if (owner.exitCode !== null || owner.signalCode !== null) return;
  tellReaper(`+${pid}`);
  owner.once("exit", () => tellReaper(`-${pid}`));
}

/**
 * Kills `child` if it's still running when this process exits. `cleanup`
 * replaces the default SIGKILL; it must be synchronous, as exit hooks are,
 * and do whatever the child's own exit listener would have done. If this
 * process is SIGKILLed, the helper kills `child` and removes `dir`.
 */
export function killOnExit(
  child: ChildProcess,
  cleanup: () => void = () => child.kill("SIGKILL"),
  { dir }: { dir?: string } = {},
): void {
  if (!hooked) {
    hooked = true;
    process.on("exit", runAll);
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  cleanups.add(cleanup);
  child.once("exit", () => cleanups.delete(cleanup));
  if (dir !== undefined) tellReaper(`d${dir}`);
  if (child.pid !== undefined) reapWith(child.pid, child);
}
