// WebSocket framing and the client for the workerd session
// (src/ws-client.ts). The workerd connection itself is covered by
// test/workerd-target.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptKey,
  connectUnixWebSocket,
  encodeFrame,
  type Frame,
  FrameDecoder,
  OP_BINARY,
  OP_CLOSE,
  OP_CONTINUATION,
  OP_PING,
  OP_PONG,
  OP_TEXT,
  type WsChannel,
} from "../src/ws-client.ts";

test("acceptKey matches RFC 6455's worked example", () => {
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("frames round-trip at every length encoding, masked or not", () => {
  for (const size of [0, 125, 126, 65535, 65536, 200_000]) {
    const payload = Buffer.alloc(size, 0x61);
    for (const mask of [Buffer.from([1, 2, 3, 4]), null]) {
      const frames = new FrameDecoder().push(encodeFrame(OP_TEXT, payload, mask));
      assert.equal(frames.length, 1, `size ${size}`);
      assert.equal(frames[0].opcode, OP_TEXT);
      assert.ok(frames[0].fin);
      assert.ok(frames[0].payload.equals(payload), `size ${size}, mask ${mask !== null}`);
    }
  }
});

test("the header says how the length is encoded, and masking is applied", () => {
  const small = encodeFrame(OP_TEXT, Buffer.from("hi"), Buffer.from([0, 0, 0, 0]));
  assert.deepEqual([...small.subarray(0, 2)], [0x81, 0x80 | 2]);
  assert.equal(encodeFrame(OP_TEXT, Buffer.alloc(300), null)[1], 126);
  assert.equal(encodeFrame(OP_TEXT, Buffer.alloc(70_000), null)[1], 127);
  const masked = encodeFrame(OP_TEXT, Buffer.from([0xff]), Buffer.from([0x0f, 0, 0, 0]));
  assert.equal(masked.at(-1), 0xf0);
});

test("the decoder holds a partial frame until the rest arrives", () => {
  const bytes = Buffer.concat([encodeFrame(OP_TEXT, Buffer.from("first"), null), encodeFrame(OP_PING, Buffer.from("p"), null)]);
  const decoder = new FrameDecoder();
  const seen = [];
  for (let i = 0; i < bytes.length; i++) seen.push(...decoder.push(bytes.subarray(i, i + 1)));
  assert.deepEqual(seen.map((f) => [f.opcode, f.payload.toString()]), [[OP_TEXT, "first"], [OP_PING, "p"]]);
});

test("a fragmented message decodes as its fragments, fin on the last", () => {
  const first = encodeFrame(OP_TEXT, Buffer.from("he"), null);
  first[0] &= 0x7f; // clear fin
  const frames = new FrameDecoder().push(Buffer.concat([first, encodeFrame(OP_CONTINUATION, Buffer.from("llo"), null)]));
  assert.deepEqual(frames.map((f) => [f.fin, f.opcode, f.payload.toString()]), [[false, OP_TEXT, "he"], [true, OP_CONTINUATION, "llo"]]);
});

test("a frame delivered in many chunks decodes once, whole", () => {
  const payload = Buffer.alloc(100_000, 0x62);
  const bytes = encodeFrame(OP_TEXT, payload, null);
  const decoder = new FrameDecoder();
  const last = bytes.length - 1;
  for (let i = 0; i < last; i += 1000) assert.deepEqual(decoder.push(bytes.subarray(i, Math.min(i + 1000, last))), []);
  const frames = decoder.push(bytes.subarray(last));
  assert.equal(frames.length, 1);
  assert.ok(frames[0].payload.equals(payload));
});

function fragment(opcode: number, payload: string, fin: boolean): Buffer {
  const frame = encodeFrame(opcode, Buffer.from(payload), null);
  if (!fin) frame[0] &= 0x7f;
  return frame;
}

/** A WebSocket server on a Unix socket that hands each connection to `onSocket`. */
async function withServer(
  onSocket: (socket: Socket, frames: (listener: (frame: Frame) => void) => void) => void,
  body: (channel: WsChannel) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cdpk-ws-"));
  const path = join(dir, "s");
  const server = createServer((socket) => {
    let head = Buffer.alloc(0);
    const decoder = new FrameDecoder();
    let listener: (frame: Frame) => void = () => {};
    let upgraded = false;
    socket.on("data", (chunk: Buffer) => {
      if (upgraded) {
        for (const frame of decoder.push(chunk)) listener(frame);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      const key = /^sec-websocket-key:\s*(\S+)/im.exec(head.toString("latin1"))![1];
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
      );
      upgraded = true;
      onSocket(socket, (l) => (listener = l));
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    await body(await connectUnixWebSocket(path));
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the client drops a fragmented binary message and keeps the text around it", async () => {
  await withServer(
    // Waits for the client's first message, so its listener is attached.
    (socket, frames) =>
      frames(() => {
        socket.write(Buffer.concat([
          fragment(OP_BINARY, "bin", false),
          fragment(OP_CONTINUATION, "ary", true),
          fragment(OP_TEXT, "te", false),
          fragment(OP_PING, "", true),
          fragment(OP_CONTINUATION, "xt", true),
          fragment(OP_BINARY, "solo", true),
          fragment(OP_TEXT, "end", true),
        ]));
      }),
    async (channel) => {
      const seen: string[] = [];
      const ended = new Promise<void>((resolve) =>
        channel.onMessage((text) => {
          seen.push(text);
          if (text === "end") resolve();
        })
      );
      channel.send("go");
      await ended;
      assert.deepEqual(seen, ["text", "end"]);
      channel.close();
    },
  );
});

test("the client answers a ping with a pong carrying its payload", async () => {
  let pong!: (frame: Frame) => void;
  const ponged = new Promise<Frame>((resolve) => (pong = resolve));
  await withServer(
    (socket, frames) => {
      frames((frame) => frame.opcode === OP_PONG && pong(frame));
      socket.write(encodeFrame(OP_PING, Buffer.from("are you there"), null));
    },
    async (channel) => {
      assert.equal((await ponged).payload.toString(), "are you there");
      channel.close();
    },
  );
});

test("the client echoes a server Close frame before closing", async () => {
  let echoed!: (frame: Frame) => void;
  const closeFrame = new Promise<Frame>((resolve) => (echoed = resolve));
  await withServer(
    (socket, frames) => {
      frames((frame) => frame.opcode === OP_CLOSE && echoed(frame));
      const status = Buffer.alloc(2);
      status.writeUInt16BE(1000);
      socket.write(encodeFrame(OP_CLOSE, Buffer.concat([status, Buffer.from("bye")]), null));
    },
    async (channel) => {
      const closed = new Promise<void>((resolve) => channel.onClose(resolve));
      assert.equal((await closeFrame).payload.readUInt16BE(0), 1000);
      await closed;
    },
  );
});
