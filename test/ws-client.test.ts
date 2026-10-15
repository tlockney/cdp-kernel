// WebSocket framing for the workerd session (src/ws-client.ts). The
// connection itself is covered by test/workerd-target.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { acceptKey, encodeFrame, FrameDecoder, OP_CONTINUATION, OP_PING, OP_TEXT } from "../src/ws-client.ts";

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
