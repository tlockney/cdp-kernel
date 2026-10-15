// The Bun target's side of the host connection (#7), in place of CDP.
//
// Bun's --inspect speaks the WebKit Inspector Protocol, which has no
// replMode, Runtime.addBinding or Runtime.terminateExecution, so the host
// doesn't drive Bun over an inspector. It sends requests as JSON lines over
// fd 3, a pipe only the host holds (there is no port to discover), and the
// cells are evaluated here, in-process, by evaluator.mjs. Replies, and the
// iopub messages that the CDP binding carries for other targets, go back the
// same way. stdout and stderr stay ordinary pipes, ordered against those
// messages by bootstrap.mjs's barrier markers.

import fs from "node:fs";

const CHANNEL_FD = 3;

/** Synchronous, like a CDP binding call, so output order is kept. */
function writeAll(fd, text) {
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length;) {
    try {
      offset += fs.writeSync(fd, bytes, offset);
    } catch (err) {
      // The reader's side of the pipe is full; the fd may be non-blocking.
      if (err.code !== "EAGAIN") throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  }
}

/**
 * Serves `handle` (see evaluator.mjs) over fd 3 and installs
 * globalThis.__cdpk_send, the function bootstrap.mjs sends iopub messages
 * through. `ready` is sent first, once the target can take requests.
 */
export function startChannel(handle, ready, fd = CHANNEL_FD) {
  const send = (message) => writeAll(fd, JSON.stringify(message) + "\n");
  Object.defineProperty(globalThis, "__cdpk_send", {
    value: (payload) => writeAll(fd, payload + "\n"),
    enumerable: false,
  });

  let buffer = "";
  const input = fs.createReadStream(null, { fd, autoClose: false, encoding: "utf8" });
  input.on("data", (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
      const request = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      handle(request).then(
        (reply) => send({ kind: "reply", id: request.id, ...reply }),
        (err) => send({ kind: "reply", id: request.id, failure: String(err?.stack ?? err) }),
      );
    }
  });
  // The host is gone; don't linger as an orphan.
  input.on("end", () => process.exit(0));
  send({ kind: "ready", ...ready });
}
