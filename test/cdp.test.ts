import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import process from "node:process";
import type { Duplex } from "node:stream";
import { asEvaluateResult, CdpSession } from "../src/cdp.ts";

test("asEvaluateResult accepts an evaluate reply, with or without exceptionDetails", () => {
  const ok = { result: { type: "number", value: 1 } };
  assert.deepEqual(asEvaluateResult(ok), ok);
  const thrown = { result: { type: "object" }, exceptionDetails: { text: "Uncaught", lineNumber: 0, columnNumber: 0 } };
  assert.deepEqual(asEvaluateResult(thrown), thrown);
  // The Bun and workerd drivers' shape for a throw.
  const details = { text: "Uncaught", lineNumber: 0, columnNumber: 0, exception: { type: "object", objectId: "h1" } };
  assert.deepEqual(asEvaluateResult({ kind: "reply", id: 1, exceptionDetails: details }), {
    result: { type: "undefined" },
    exceptionDetails: details,
  });
});

test("asEvaluateResult rejects a reply without a RemoteObject", () => {
  assert.throws(() => asEvaluateResult({}), /malformed evaluate result/);
  assert.throws(() => asEvaluateResult({ result: 1 }), /malformed evaluate result/);
  assert.throws(() => asEvaluateResult({ result: { type: "number" }, exceptionDetails: "x" }), /malformed evaluate result/);
  assert.throws(() => asEvaluateResult({ exceptionDetails: {} }), /malformed evaluate result/);
});

/** A WebSocket server that answers the first frame with `reply`, unmasked as servers send. */
function badServer(reply: string): Promise<{ url: string; close: () => void }> {
  const server = createServer();
  const sockets = new Set<Duplex>();
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.once("data", () => {
      const payload = Buffer.from(reply);
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `ws://127.0.0.1:${port}/`,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });
}

test("a frame that isn't JSON fails the session's calls instead of throwing out of its listener", { timeout: 5_000 }, async () => {
  const server = await badServer("not json");
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);
  process.on("uncaughtException", onUncaught);
  try {
    const session = await CdpSession.connect(server.url);
    let closes = 0;
    // What lets a Target stop a runtime it can no longer drive.
    session.onClose(() => closes++);
    await assert.rejects(session.send("Runtime.evaluate", { expression: "1" }), /isn't JSON/);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(uncaught, []);
    assert.equal(closes, 1);
    await assert.rejects(session.send("Runtime.evaluate", { expression: "1" }), /CDP connection closed/);
  } finally {
    process.off("uncaughtException", onUncaught);
    server.close();
  }
});
