// The in-process evaluator behind the targets that don't use CDP: Bun (#7),
// over a pipe (bun-channel.mjs), and workerd (#8), inside a request
// (workerd-worker.mjs). Cells arrive as global code from
// src/transform.ts's transformCellForEval, whose value is a promise of the
// boxed result. Requests and replies mirror the CDP calls the kernel makes
// of the other targets.
//
// No imports: this file must load in every target.

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
