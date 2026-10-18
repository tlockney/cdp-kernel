// The driver for the browser target: a module Web Worker that runs cells.
//
// The page's kernel (src/browser/target.ts) sends each request as a
// message and gets a reply message back, as over the workerd driver's
// WebSocket (runtime/workerd-worker.mjs), whose shape this follows. Cells
// come from transformCellForEval and run as global code with indirect
// eval, so their declarations persist from cell to cell.
//
// A Worker has no module resolution beyond URLs, so `npm:` and `jsr:`
// specifiers, and bare package names, load from a CDN (esm.sh by default).

import { createJupyter } from "./display.mjs";
import { createHandler } from "./evaluator.mjs";
import { format, inspect } from "./format.mjs";
import { describeValue, inspectPath, resolvePath } from "./introspect.mjs";
import { DEFAULT_CDN, resolveSpecifier } from "./cdn.mjs";

function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const post = (message) => globalThis.postMessage(message);

// --- Output -----------------------------------------------------------------
const stream = (name) => (...args) => post({ kind: "stream", name, text: format(...args) + "\n" });
Object.assign(console, {
  log: stream("stdout"),
  info: stream("stdout"),
  debug: stream("stdout"),
  dir: (value) => post({ kind: "stream", name: "stdout", text: inspect(value, { depth: 4 }) + "\n" }),
  warn: stream("stderr"),
  error: stream("stderr"),
});

// An error thrown later by a cell's timer or promise goes to stderr, as on
// the other targets.
function reportUncaught(kind, err) {
  post({ kind: "stream", name: "stderr", text: `${kind}: ${err instanceof Error ? (err.stack ?? err.message) : inspect(err)}\n` });
}
globalThis.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  reportUncaught("Uncaught (in promise)", event.reason);
});
globalThis.addEventListener("error", (event) => {
  event.preventDefault();
  reportUncaught("Uncaught", event.error ?? event.message);
});

const jupyter = createJupyter({
  inspect: (value) => inspect(value, { depth: 4 }),
  base64,
  readFile() {
    throw new Error("the browser target has no file system to read from; pass the image bytes instead");
  },
  send(msgType, content, metadata, buffers) {
    post({ kind: "iopub", msg_type: msgType, content, metadata, buffers: buffers.map(base64), barrier: 0 });
  },
  // A synchronous prompt would need SharedArrayBuffer and Atomics.wait, so
  // a cross-origin isolated page; until then, as with no stdin.
  input: () => null,
});

// --- Modules ----------------------------------------------------------------
let cdn = DEFAULT_CDN;


// --- The shim cells and the evaluator use -----------------------------------
let handle = null;

function install({ base, cdn: cdnBase }) {
  if (typeof cdnBase === "string") cdn = cdnBase.endsWith("/") ? cdnBase : cdnBase + "/";
  const url = new URL("$cdpk$repl.mjs", base).href;
  globalThis.__cdpk = {
    import: (specifier, options) => import(resolveSpecifier(specifier, url, cdn), options),
    meta: { url, resolve: (specifier) => resolveSpecifier(specifier, url, cdn) },
    // inspect_request (#10): by descriptor, so nothing runs.
    describeForInspect: (value, detail) => describeValue(value, { inspect: (v) => inspect(v, { depth: 2 }), detail }),
    inspectPath: (path, detail) => inspectPath(path, { inspect: (v) => inspect(v, { depth: 2 }), detail }),
    resolvePath,
    barrier: () => 0,
    broadcastResult: jupyter.broadcastResult,
    async commDispatch(msgType, content, metadata, buffers64) {
      const buffers = buffers64.map((b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
      return await jupyter.commDispatch(msgType, content, metadata, buffers);
    },
    describeError(value) {
      if (value instanceof Error) {
        return JSON.stringify({ name: value.name, message: value.message, stack: value.stack ?? "" });
      }
      return JSON.stringify({ name: "Error", message: inspect(value), stack: "" });
    },
  };
  Object.defineProperty(globalThis, "__cdpk", { enumerable: false });
  globalThis.jupyter = jupyter.namespace;
  globalThis.prompt = jupyter.prompt;
  globalThis.confirm = jupyter.confirm;
  handle = createHandler(globalThis.__cdpk, (code) => (0, eval)(code));
}

async function answer(req) {
  if (req.op === "info") {
    install(req);
    return { userAgent: globalThis.navigator?.userAgent ?? "" };
  }
  if (handle === null) throw new Error("the driver wasn't sent info first");
  return await handle(req);
}

globalThis.addEventListener("message", (event) => {
  const req = event.data;
  answer(req).then(
    (reply) => post({ kind: "reply", id: req.id, ...reply }),
    (err) => post({ kind: "reply", id: req.id, failure: String(err?.stack ?? err) }),
  );
});
