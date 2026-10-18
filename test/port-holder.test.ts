// The kernel names who holds a connection-file port it couldn't bind (#257).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { portHolders, socketsOnPort } from "../src/port-holder.ts";

const TABLE = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:AA2D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 81234 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1F90 0100007F:AA2D 01 00000000:00000000 00:00000000 00000000  1001        0 81240 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:AA2D 0100007F:9C40 06 00000000:00000000 03:00001770 00000000     0        0 0 3 0000000000000000
`;

test("socketsOnPort matches the local port only", () => {
  assert.deepEqual(socketsOnPort(TABLE, 0xaa2d), [
    { remote: "00000000:0000", state: "LISTEN", inode: "81234" },
    { remote: "0100007F:9C40", state: "TIME_WAIT", inode: "0" },
  ]);
  assert.deepEqual(socketsOnPort(TABLE, 1), []);
});

test("portHolders names the process listening on a port", { skip: process.platform !== "linux" }, async (t) => {
  const holder = spawn(process.execPath, [
    "-e",
    `require("node:net").createServer().listen(0, "127.0.0.1", function () { console.log(this.address().port); });`,
  ], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => holder.kill("SIGKILL"));
  const port = await new Promise<number>((resolve) => holder.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk))));
  const [line, ...rest] = portHolders(port);
  assert.deepEqual(rest, []);
  assert.match(line, new RegExp(`^LISTEN to 00000000:0000, pid ${holder.pid} \\(ppid ${process.pid}\\): .*node`));
});
