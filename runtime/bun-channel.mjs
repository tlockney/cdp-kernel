// The Bun target's side of the host connection (#7), in place of CDP.
//
// Bun's --inspect speaks the WebKit Inspector Protocol, which has no
// replMode, Runtime.addBinding or Runtime.terminateExecution, so the host
// doesn't drive Bun over an inspector. It sends requests as JSON lines over
// fd 3, a pipe only the host holds (there is no port to discover), and the
// cells are evaluated here, in-process: src/transform.ts's
// transformCellForEval turns each into global code whose value is a promise
// of the boxed result. Replies, and the iopub messages that the CDP binding
// carries for other targets, go back the same way. stdout and stderr stay
// ordinary pipes, ordered against those messages by bootstrap.mjs's barrier
// markers.

import fs from "node:fs";

const CHANNEL_FD = 3;

/** Own and inherited property names, as Runtime.getProperties lists them. */
export function propertyNames(value) {
  if (value === null || value === undefined) return [];
  const names = new Set();
  for (let o = Object(value); o !== null; o = Object.getPrototypeOf(o)) {
    for (const name of Object.getOwnPropertyNames(o)) names.add(name);
  }
  return [...names];
}

/**
 * Answers the host's requests. `shim` is globalThis.__cdpk; `evaluate` runs
 * global code. Values the host refers to later (a result to display, an
 * error to describe) stay here under a handle, the stand-in for a CDP
 * objectId.
 */
export function createHandler(shim, evaluate = (code) => (0, eval)(code)) {
  const handles = new Map();
  let nextHandle = 0;
  const remote = (value) => {
    const objectId = `h${++nextHandle}`;
    handles.set(objectId, value);
    return { type: value === null ? "object" : typeof value, objectId };
  };
  const take = (objectId) => {
    const value = handles.get(objectId);
    handles.delete(objectId);
    return value;
  };

  return async function handle(request) {
    switch (request.op) {
      case "ping":
        return {};
      case "eval": {
        // The host uses a result's handle before its next cell.
        handles.clear();
        try {
          const box = await evaluate(request.code);
          return { result: box === undefined ? { type: "undefined" } : remote(box[0]) };
        } catch (err) {
          return {
            exceptionDetails: { text: "Uncaught", lineNumber: 0, columnNumber: 0, exception: remote(err) },
          };
        }
      }
      case "broadcast":
        await shim.broadcastResult(request.count, take(request.handle));
        return {};
      case "describe":
        return { value: shim.describeError(take(request.handle)) };
      case "comm":
        try {
          const handled = await shim.commDispatch(request.msgType, request.content, request.metadata, request.buffers);
          return { handled: handled === true };
        } catch (err) {
          return { error: JSON.parse(shim.describeError(err)) };
        }
      case "props": {
        let value;
        try {
          value = evaluate(`(${request.expr})`);
        } catch {
          return { names: [] };
        }
        return { names: propertyNames(value) };
      }
      case "barrier":
        return { value: shim.barrier() };
      default:
        throw new Error(`unknown request ${JSON.stringify(request.op)}`);
    }
  };
}

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
 * Serves `handle` over fd 3 and installs globalThis.__cdpk_send, the
 * function bootstrap.mjs sends iopub messages through. `ready` is sent
 * first, once the target can take requests.
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
