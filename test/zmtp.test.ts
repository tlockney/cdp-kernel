import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, type AddressInfo } from "node:net";
import {
  encodeFrame,
  encodeMultipart,
  makeGreeting,
  makeReadyCommand,
  Queue,
  readFrame,
  RouterSocket,
  SocketReader,
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
