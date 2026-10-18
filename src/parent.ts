// The server that started the kernel, watched so a server that dies without
// shutting the kernel down (SIGKILL, a crash) doesn't leave it running with
// its runtime and ports (#254). jupyter_server and Ganymede put their pid in
// JPY_PARENT_PID; ipykernel's ParentPollerUnix polls for the same thing.
import process from "node:process";

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, under another user.
    return (err as { code?: string }).code === "EPERM";
  }
}

/**
 * Calls `onGone` once the parent named by JPY_PARENT_PID has exited: its pid
 * is gone, or this process was reparented. A no-op when the variable is
 * unset, so a kernel started by hand keeps running; and on Windows, where
 * ipykernel's variable is a handle, not a pid. A pid that doesn't exist at
 * start (the server is in another pid namespace) is ignored, leaving only
 * the reparenting check.
 */
export function watchParent(onGone: () => void, { env = process.env, intervalMs = 1000 } = {}): () => void {
  const parent = Number(env.JPY_PARENT_PID);
  if (process.platform === "win32" || !Number.isInteger(parent) || parent <= 1) return () => {};
  const ppid = process.ppid;
  const checkPid = exists(parent);
  const timer = setInterval(() => {
    if (process.ppid === ppid && (!checkPid || exists(parent))) return;
    clearInterval(timer);
    onGone();
  }, intervalMs);
  // The kernel's sockets keep it running; this mustn't.
  timer.unref();
  return () => clearInterval(timer);
}
