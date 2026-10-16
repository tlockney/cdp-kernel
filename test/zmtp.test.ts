import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import {
  encodeFrame,
  encodeMultipart,
  makeGreeting,
  makeReadyCommand,
  PubSocket,
  Queue,
  readFrame,
  recvMultipart,
  RouterSocket,
  SocketReader,
  startHeartbeat,
} from "../src/zmtp.ts";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

test("encodeFrame short frame", () => {
  const data = ENC.encode("hi");
  assert.deepEqual([...encodeFrame(data, false)], [0x00, 2, 0x68, 0x69]);
  assert.equal(encodeFrame(data, true)[0], 0x01);
  assert.equal(encodeFrame(data, false, true)[0], 0x04);
  assert.equal(encodeFrame(data, true, true)[0], 0x05);
});

test("encodeFrame boundary at 255 bytes stays short", () => {
  const frame = encodeFrame(new Uint8Array(255), false);
  assert.equal(frame.length, 2 + 255);
  assert.equal(frame[0], 0x00);
  assert.equal(frame[1], 255);
});

test("encodeFrame long frame uses flag 0x02 and 8-byte big-endian length", () => {
  const frame = encodeFrame(new Uint8Array(256).fill(7), true, true);
  assert.equal(frame.length, 9 + 256);
  assert.equal(frame[0], 0x01 | 0x02 | 0x04);
  assert.deepEqual([...frame.subarray(1, 9)], [0, 0, 0, 0, 0, 0, 1, 0]);
  assert.equal(frame[9], 7);
  const long = encodeFrame(new Uint8Array(70000), false);
  assert.equal(new DataView(long.buffer).getBigUint64(1), 70000n);
});

test("encodeMultipart sets the more flag on all but the last frame", () => {
  const buf = encodeMultipart([ENC.encode("a"), ENC.encode("b"), ENC.encode("c")]);
  assert.deepEqual([...buf], [1, 1, 0x61, 1, 1, 0x62, 0, 1, 0x63]);
});

test("makeGreeting layout", () => {
  const g = makeGreeting();
  assert.equal(g.length, 64);
  assert.equal(g[0], 0xff);
  assert.equal(g[9], 0x7f);
  assert.equal(g[10], 3);
  assert.equal(g[11], 0);
  assert.equal(DEC.decode(g.subarray(12, 16)), "NULL");
  assert.ok(g.subarray(16, 32).every((b) => b === 0));
  assert.equal(g[32], 0);
});

test("makeReadyCommand parses back to READY with Socket-Type", () => {
  const frame = makeReadyCommand("ROUTER");
  assert.equal(frame[0], 0x04);
  const body = frame.subarray(2, 2 + frame[1]);
  let o = 0;
  const nameLen = body[o++];
  assert.equal(DEC.decode(body.subarray(o, o + nameLen)), "READY");
  o += nameLen;
  const propLen = body[o++];
  assert.equal(DEC.decode(body.subarray(o, o + propLen)), "Socket-Type");
  o += propLen;
  const valueLen = new DataView(body.buffer, body.byteOffset).getUint32(o);
  o += 4;
  assert.equal(DEC.decode(body.subarray(o, o + valueLen)), "ROUTER");
  assert.equal(o + valueLen, body.length);
});

test("Queue delivers in order whether pushed or popped first", async () => {
  const q = new Queue<number>();
  q.push(1);
  q.push(2);
  assert.equal(await q.pop(), 1);
  assert.equal(await q.pop(), 2);

  const first = q.pop();
  const second = q.pop();
  q.push(3);
  q.push(4);
  assert.equal(await first, 3);
  assert.equal(await second, 4);
});

test("RouterSocket loopback: handshake, receive multipart, send back", async () => {
  const router = new RouterSocket(0, "127.0.0.1");
  const client = connect;
  let socket: ReturnType<typeof connect> | undefined;
  try {
    await new Promise<void>((resolve) => router.server.once("listening", resolve));
    const { port } = router.server.address() as AddressInfo;

    socket = client(port, "127.0.0.1");
    const reader = new SocketReader(socket);
    socket.write(makeGreeting());
    socket.write(makeReadyCommand("DEALER"));

    const greeting = await reader.readExact(64);
    assert.equal(greeting[0], 0xff);
    assert.equal(greeting[9], 0x7f);
    const ready = await readFrame(reader);
    assert.equal(ready.isCommand, true);
    assert.equal(ready.hasMore, false);
    assert.match(DEC.decode(ready.data), /READY.*Socket-Type.*ROUTER/s);

    // A frame larger than 255 bytes exercises the long-frame path too.
    const big = new Uint8Array(300).fill(0x41);
    socket.write(encodeMultipart([ENC.encode("one"), big, ENC.encode("three")]));
    const { peer, frames } = await router.recv();
    assert.equal(frames.length, 3);
    assert.equal(DEC.decode(frames[0]), "one");
    assert.deepEqual(frames[1], big);
    assert.equal(DEC.decode(frames[2]), "three");

    router.send(peer, [ENC.encode("x"), ENC.encode("y")]);
    const f1 = await readFrame(reader);
    const f2 = await readFrame(reader);
    assert.deepEqual([DEC.decode(f1.data), f1.hasMore], ["x", true]);
    assert.deepEqual([DEC.decode(f2.data), f2.hasMore], ["y", false]);
  } finally {
    socket?.destroy();
    for (const peerSocket of router.peers.values()) peerSocket.destroy();
    await new Promise<void>((resolve) => router.server.close(() => resolve()));
  }
});

/** A SocketReader over a stand-in socket, fed by hand. */
function fedReader(): { reader: SocketReader; feed(bytes: Uint8Array): void } {
  const socket = new EventEmitter();
  return { reader: new SocketReader(socket as Socket), feed: (bytes) => void socket.emit("data", Buffer.from(bytes)) };
}

test("frames split across reads decode, one byte at a time", async () => {
  const { reader, feed } = fedReader();
  const big = new Uint8Array(300).map((_, i) => i % 251);
  const wire = encodeMultipart([ENC.encode("one"), big, new Uint8Array(0)]);
  const received = recvMultipart(reader);
  for (const byte of wire) {
    feed(new Uint8Array([byte]));
    await new Promise((r) => setImmediate(r));
  }
  const frames = await received;
  assert.equal(frames.length, 3);
  assert.equal(DEC.decode(frames[0]), "one");
  assert.deepEqual(frames[1], big);
  assert.equal(frames[2].length, 0, "a zero-length frame is kept");
});

test("recvMultipart skips command frames, before and between message frames", async () => {
  const { reader, feed } = fedReader();
  const subscribe = encodeFrame(ENC.encode("\x09SUBSCRIBE"), false, true);
  const ping = encodeFrame(ENC.encode("\x04PING\x00\x00"), false, true);
  feed(subscribe);
  feed(encodeFrame(ENC.encode("a"), true));
  feed(ping);
  feed(encodeFrame(ENC.encode("b"), false));
  feed(encodeMultipart([ENC.encode("next")]));
  assert.deepEqual((await recvMultipart(reader)).map((f) => DEC.decode(f)), ["a", "b"]);
  assert.deepEqual((await recvMultipart(reader)).map((f) => DEC.decode(f)), ["next"]);
});

test("SocketReader fails a pending read when the connection closes", async () => {
  const socket = new EventEmitter();
  const reader = new SocketReader(socket as Socket);
  const pending = reader.readExact(4);
  socket.emit("data", Buffer.from([1, 2]));
  socket.emit("close");
  await assert.rejects(pending, /connection closed/);
});

// --- Loopback sockets ---------------------------------------------------------

async function listening(server: Server, t: { after(fn: () => void): void }): Promise<number> {
  // Not awaited: close() waits for open connections, and the clients' own
  // after() hooks, which end them, run later.
  t.after(() => void server.close());
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  return (server.address() as AddressInfo).port;
}

/** A client that has completed the ZMTP handshake as `socketType`. */
async function peer(port: number, socketType: string, t: { after(fn: () => void): void }) {
  const socket = connect(port, "127.0.0.1");
  t.after(() => socket.destroy());
  const reader = new SocketReader(socket);
  socket.write(makeGreeting());
  socket.write(makeReadyCommand(socketType));
  await reader.readExact(64);
  assert.equal((await readFrame(reader)).isCommand, true);
  return { socket, reader };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("heartbeat echoes each message back", async (t) => {
  const server = startHeartbeat(0, "127.0.0.1");
  const port = await listening(server, t);
  const { socket, reader } = await peer(port, "REQ", t);
  socket.write(encodeMultipart([ENC.encode("ping"), ENC.encode("2")]));
  assert.deepEqual((await recvMultipart(reader)).map((f) => DEC.decode(f)), ["ping", "2"]);
  socket.write(encodeMultipart([ENC.encode("again")]));
  assert.deepEqual((await recvMultipart(reader)).map((f) => DEC.decode(f)), ["again"]);
});

test("PubSocket fans out to every subscriber, whatever they send", async (t) => {
  const pub = new PubSocket(0, "127.0.0.1");
  t.after(() => {
    for (const socket of pub.subscribers) socket.destroy();
  });
  const port = await listening(pub.server, t);
  const a = await peer(port, "SUB", t);
  const b = await peer(port, "SUB", t);
  // ZMTP 3.1 subscribes with a command frame, 3.0 with a 0x01-prefixed message.
  a.socket.write(encodeFrame(ENC.encode("\x09SUBSCRIBE"), false, true));
  b.socket.write(encodeFrame(new Uint8Array([1]), false));
  await until(() => pub.subscribers.size === 2);
  pub.send([ENC.encode("topic"), ENC.encode("body")]);
  for (const { reader } of [a, b]) {
    assert.deepEqual((await recvMultipart(reader)).map((f) => DEC.decode(f)), ["topic", "body"]);
  }
  b.socket.destroy();
  await until(() => pub.subscribers.size === 1);
  pub.send([ENC.encode("later")]);
  assert.deepEqual((await recvMultipart(a.reader)).map((f) => DEC.decode(f)), ["later"]);
});

test("RouterSocket keeps peers apart: replies go to their sender, sendAll to everyone", async (t) => {
  const router = new RouterSocket(0, "127.0.0.1");
  t.after(() => {
    for (const socket of router.peers.values()) socket.destroy();
  });
  const port = await listening(router.server, t);
  const a = await peer(port, "DEALER", t);
  const b = await peer(port, "DEALER", t);
  a.socket.write(encodeMultipart([ENC.encode("from a")]));
  const fromA = await router.recv();
  b.socket.write(encodeMultipart([ENC.encode("from b")]));
  const fromB = await router.recv();
  assert.deepEqual([DEC.decode(fromA.frames[0]), DEC.decode(fromB.frames[0])], ["from a", "from b"]);
  assert.notEqual(fromA.peer, fromB.peer);

  router.send(fromB.peer, [ENC.encode("to b")]);
  router.sendAll([ENC.encode("to all")]);
  assert.deepEqual((await recvMultipart(a.reader)).map((f) => DEC.decode(f)), ["to all"], "a gets only the broadcast");
  assert.deepEqual((await recvMultipart(b.reader)).map((f) => DEC.decode(f)), ["to b"]);
  assert.deepEqual((await recvMultipart(b.reader)).map((f) => DEC.decode(f)), ["to all"]);

  a.socket.destroy();
  await until(() => router.peers.size === 1);
  router.send(fromA.peer, [ENC.encode("gone")]); // a departed peer is dropped quietly
});

test("RouterSocket waits for a port that is briefly in use", async () => {
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const { port } = holder.address() as AddressInfo;
  const router = new RouterSocket(port, "127.0.0.1");
  try {
    setTimeout(() => holder.close(), 300);
    await new Promise<void>((resolve) => router.server.once("listening", resolve));
    assert.equal((router.server.address() as AddressInfo).port, port);
  } finally {
    holder.close();
    router.server.close();
  }
});
