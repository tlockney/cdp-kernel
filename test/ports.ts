// Ports for a test kernel's connection file. They come from below the
// ephemeral ranges (Linux 32768+, macOS 49152+), so nothing else in a
// parallel test run that binds port 0, such as a runtime's inspector, can
// take one before the kernel binds it (#257).
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const LOW = 20000;
const HIGH = 32000;
const taken = new Set<number>();

/** A free port this process hasn't handed out before. */
export async function freePort(): Promise<number> {
  for (;;) {
    const port = LOW + Math.floor(Math.random() * (HIGH - LOW));
    if (taken.has(port)) continue;
    const server = createServer();
    const free = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (!free) continue;
    await new Promise((resolve) => server.close(resolve));
    taken.add(port);
    return port;
  }
}

/** Writes a connection file with five such ports to `dir`. */
export async function connectionFile(dir: string): Promise<string> {
  const ports = { shell_port: 0, control_port: 0, stdin_port: 0, iopub_port: 0, hb_port: 0 };
  for (const name of Object.keys(ports) as (keyof typeof ports)[]) ports[name] = await freePort();
  const path = join(dir, "conn.json");
  writeFileSync(path, JSON.stringify({ ...ports, ip: "127.0.0.1", key: "", transport: "tcp", signature_scheme: "hmac-sha256" }));
  return path;
}
