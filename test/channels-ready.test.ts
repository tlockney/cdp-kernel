// The kernel answers on shell and control only once all five ports are
// bound. A client that has kernel_info_reply goes on to the heartbeat port,
// and an unbound one reads as a dead kernel (#438).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KernelCore } from "../src/kernel-core.ts";
import { decodeMessage, encodeMessage } from "../src/wire.ts";
import { encodeMultipart, makeGreeting, makeReadyCommand, readFrame, recvMultipart, SocketReader } from "../src/zmtp.ts";
import { FakeChannels } from "./fake-channels.ts";
import { freePort } from "./ports.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MAIN = join(REPO, "src", "main.ts");
const ENC = new TextEncoder();
const DEC = new TextDecoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class LateChannels extends FakeChannels {
  bound!: () => void;
  override readonly ready = new Promise<void>((resolve) => (this.bound = resolve));
}

test("no shell or control reply before the channels are ready", async () => {
  const channels = new LateChannels();
  const core = new KernelCore({
    runtime: "node",
    version: "0",
    channels,
    launchTarget: () => new Promise(() => {}),
    log: () => {},
    exit: () => {},
  });
  void core.run();
  channels.push("shell", "kernel_info_request");
  channels.push("control", "kernel_info_request");
  await sleep(50);
  assert.deepEqual(channels.replies, []);
  channels.bound();
  await channels.replyOf("kernel_info_reply");
  while (channels.replies.length < 2) await sleep(5);
});

/** A ZMTP client of `socketType` on `port`, once the handshake is done; null if nothing listens yet. */
async function peer(port: number, socketType: string): Promise<{ socket: Socket; reader: SocketReader } | null> {
  const socket = connect(port, "127.0.0.1");
  const connected = await new Promise<boolean>((resolve) => {
    socket.once("connect", () => resolve(true));
    socket.once("error", () => resolve(false));
  });
  if (!connected) {
    socket.destroy();
    return null;
  }
  const reader = new SocketReader(socket);
  socket.write(makeGreeting());
  socket.write(makeReadyCommand(socketType));
  await reader.readExact(64);
  assert.equal((await readFrame(reader)).isCommand, true);
  return { socket, reader };
}

async function listen(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

test("the heartbeat answers by the time kernel_info_reply arrives", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cdpk-ready-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ports: number[] = [];
  for (let i = 0; i < 5; i++) ports.push(await freePort());
  const [shellPort, , , , hbPort] = ports;
  // The heartbeat port is taken while the kernel starts, so shell is bound first.
  const held = await listen(hbPort);
  t.after(() => held.close());
  const conn = join(dir, "conn.json");
  writeFileSync(conn, JSON.stringify({
    shell_port: ports[0], control_port: ports[1], stdin_port: ports[2], iopub_port: ports[3], hb_port: ports[4],
    ip: "127.0.0.1", key: "", transport: "tcp", signature_scheme: "hmac-sha256",
  }));
  const kernel = spawn(process.execPath, [MAIN, "kernel", "--runtime", "node", "--conn", conn], { cwd: REPO, stdio: "ignore" });
  t.after(() => kernel.kill("SIGKILL"));

  // kernel_info_request as soon as shell accepts.
  let shell: Awaited<ReturnType<typeof peer>> = null;
  for (let i = 0; i < 400 && shell === null; i++) {
    shell = await peer(shellPort, "DEALER");
    if (shell === null) await sleep(25);
  }
  assert.ok(shell, "shell never accepted");
  t.after(() => shell.socket.destroy());
  const request = encodeMessage("s", "", "kernel_info_request", {});
  shell.socket.write(encodeMultipart(request));
  let replied = false;
  const reply = recvMultipart(shell.reader).then((frames) => {
    replied = true;
    return decodeMessage(frames);
  });

  await sleep(500);
  assert.equal(replied, false, "kernel_info_reply sent while the heartbeat port was unbound");
  await new Promise((resolve) => held.close(resolve));
  assert.equal((await reply).header.msg_type, "kernel_info_reply");

  // Bound by now: one try, no retry.
  const hb = await peer(hbPort, "REQ");
  assert.ok(hb, "heartbeat port not bound when kernel_info_reply arrived");
  t.after(() => hb.socket.destroy());
  hb.socket.write(encodeMultipart([ENC.encode("ping")]));
  assert.deepEqual((await recvMultipart(hb.reader)).map((f) => DEC.decode(f)), ["ping"]);
});
