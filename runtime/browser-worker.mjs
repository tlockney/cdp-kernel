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
//
// The page can also offer cells its own features (#384): `host` requests go
// to the page's handler, and `preload` modules run before the first cell.

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


// --- The host page (#384) -----------------------------------------------------
// Requests to the page's `host` handler (src/browser/target.ts), and events
// it sends. Preload modules get this object; cells only through them.
const hostCalls = new Map();
const hostListeners = new Set();
let nextHostId = 0;

function hostError(error) {
  const err = new Error(String(error?.message ?? "the host request failed"));
  if (typeof error?.name === "string") err.name = error.name;
  if (error?.code !== undefined) err.code = error.code;
  return err;
}

const host = {
  /** Resolves with the page's answer; aborting `signal` cancels the call on the page too. */
  request(method, params, { signal, transfer } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = ++nextHostId;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        hostCalls.delete(id);
        post({ kind: "host", id, cancel: true });
        reject(signal.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const done = () => signal?.removeEventListener("abort", onAbort);
      try {
        globalThis.postMessage({ kind: "host", id, method, params }, transfer ?? []);
      } catch (err) {
        done(); // params structured clone can't copy
        throw err;
      }
      hostCalls.set(id, { resolve, reject, done });
    });
  },
  /** Calls `listener(event, value)` for each event the page sends; returns a function that stops it. */
  onEvent(listener) {
    hostListeners.add(listener);
    return () => hostListeners.delete(listener);
  },
};

function receiveHost(msg) {
  if (msg.id === undefined) {
    for (const listener of hostListeners) {
      try {
        listener(msg.event, msg.value);
      } catch (err) {
        reportUncaught("Uncaught", err);
      }
    }
    return;
  }
  const call = hostCalls.get(msg.id);
  if (!call) return; // cancelled
  hostCalls.delete(msg.id);
  call.done();
  if (msg.error !== undefined) call.reject(hostError(msg.error));
  else call.resolve(msg.result);
}

// Each module is imported in order, and a default export that is a function
// is called with the host. A module that fails is reported, and the kernel
// runs without it.
async function preload(urls, base) {
  for (const specifier of Array.isArray(urls) ? urls : []) {
    try {
      const mod = await import(new URL(specifier, base).href);
      if (typeof mod.default === "function") await mod.default({ host, jupyter: jupyter.namespace });
    } catch (err) {
      reportUncaught(`Preloading ${specifier} failed`, err);
    }
  }
}

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
    // execute_request's user_expressions (#340).
    formatJson: async (value) => JSON.stringify(await jupyter.namespace.format(value)),
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
    await preload(req.preload, req.base);
    return { userAgent: globalThis.navigator?.userAgent ?? "" };
  }
  if (handle === null) throw new Error("the driver wasn't sent info first");
  return await handle(req);
}

globalThis.addEventListener("message", (event) => {
  const req = event.data;
  if (req?.op === "host") return receiveHost(req);
  answer(req).then(
    (reply) => post({ kind: "reply", id: req.id, ...reply }),
    (err) => post({ kind: "reply", id: req.id, failure: String(err?.stack ?? err) }),
  );
});
