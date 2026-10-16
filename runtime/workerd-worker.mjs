// The driver Worker for the workerd target (#8).
//
// workerd's inspector can evaluate code, but outside a request there is no
// IoContext: timers, fetch and crypto.randomUUID throw "Disallowed operation
// called within global scope". So the host opens one WebSocket session to
// this Worker (over a Unix socket only it can reach, or through a project's
// Miniflare) and every request runs inside that session's request. The cell
// code itself comes from transformCellForEval and is run by the UnsafeEval
// binding as global code, so its declarations persist (see evaluator.mjs).
//
// Console output, iopub messages and replies all go back over the one
// socket, in order, so no barrier markers are needed.
//
// workerd can't load modules at runtime beyond its builtins, so the host
// bundles anything else a cell imports (src/workerd-target.ts) and sends it
// with the cell.

import { formatWithOptions, inspect } from "node:util";
import { createJupyter } from "./display.mjs";
import { createHandler } from "./evaluator.mjs";
import { describeValue, inspectPath, resolvePath } from "./introspect.mjs";

const BUILTIN = /^(?:node|cloudflare|workerd):/;

function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// --- Output -----------------------------------------------------------------
// Lines go to the host's session. Anything emitted before it connects waits.
let sink = null;
const outbox = [];

function emit(message) {
  const line = JSON.stringify(message);
  if (sink) sink(line);
  else outbox.push(line);
}

const stream = (name) => (...args) => emit({ kind: "stream", name, text: formatWithOptions({ colors: true }, ...args) + "\n" });
Object.assign(console, {
  log: stream("stdout"),
  info: stream("stdout"),
  debug: stream("stdout"),
  dir: (value) => emit({ kind: "stream", name: "stdout", text: inspect(value, { colors: true, depth: 4 }) + "\n" }),
  warn: stream("stderr"),
  error: stream("stderr"),
});

// An error thrown later by a cell's timer or promise goes to stderr, as on
// the other targets (runtime/bootstrap.mjs). Workers has no global "error"
// event, so timer callbacks report their own (#148), and so do the
// promises they return: celld doesn't dispatch "unhandledrejection".
function reportUncaught(kind, err) {
  emit({ kind: "stream", name: "stderr", text: `${kind}: ${err instanceof Error ? (err.stack ?? err.message) : inspect(err)}\n` });
}
// A rejection both runtimes' events report is shown once.
const reported = new WeakSet();
function reportRejection(reason) {
  if (typeof reason === "object" && reason !== null) {
    if (reported.has(reason)) return;
    reported.add(reason);
  }
  reportUncaught("Uncaught (in promise)", reason);
}
globalThis.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  reportRejection(event.reason);
});
globalThis.process?.on?.("unhandledRejection", reportRejection);
const reporting = (callback) =>
  typeof callback !== "function" ? callback : function (...args) {
    let result;
    try {
      result = callback.apply(this, args);
    } catch (err) {
      reportUncaught("Uncaught", err);
      return;
    }
    if (typeof result?.then === "function") result.then(undefined, reportRejection);
    return result;
  };
for (const name of ["setTimeout", "setInterval", "queueMicrotask"]) {
  const original = globalThis[name];
  globalThis[name] = { [name]: (callback, ...rest) => original(reporting(callback), ...rest) }[name];
}

const jupyter = createJupyter({
  inspect: (value) => inspect(value, { colors: true, depth: 4 }),
  base64,
  readFile() {
    throw new Error("workerd has no file system to read from; pass the image bytes instead");
  },
  send(msgType, content, metadata, buffers) {
    emit({ kind: "iopub", msg_type: msgType, content, metadata, buffers: buffers.map(base64), barrier: 0 });
  },
  // A request can't block for an answer, so prompt() and confirm() behave
  // as when the frontend has no stdin.
  input: () => null,
});

// --- Modules ----------------------------------------------------------------
const modules = new Map();

/** `require` for a host-built bundle's external imports (builtins). */
async function requireFor(specifiers) {
  const loaded = new Map();
  for (const specifier of specifiers) {
    // Packages require Node builtins by bare name too ("fs").
    const ns = await import(BUILTIN.test(specifier) ? specifier : `node:${specifier}`);
    loaded.set(specifier, ns.default ?? ns);
  }
  return (specifier) => {
    if (!loaded.has(specifier)) throw new Error(`cannot require ${specifier} in workerd`);
    return loaded.get(specifier);
  };
}

function cellImport(specifier, options) {
  if (BUILTIN.test(specifier)) return import(specifier, options);
  if (modules.has(specifier)) return modules.get(specifier);
  return Promise.reject(new TypeError(`Cannot import "${specifier}": the host didn't bundle it`));
}

// --- The shim cells and the evaluator use -----------------------------------
let handle = null;

function install(env) {
  const meta = JSON.parse(env.META);
  globalThis.__cdpk = {
    import: cellImport,
    meta: { ...meta, resolve: (specifier) => new URL(specifier, meta.url).href },
    requireFor,
    // inspect_request (#10): by descriptor, so nothing runs.
    describeForInspect: (value, detail) => describeValue(value, { inspect: (v) => inspect(v, { colors: false, depth: 2 }), detail }),
    inspectPath: (path, detail) => inspectPath(path, { inspect: (v) => inspect(v, { colors: false, depth: 2 }), detail }),
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
  // A cell has no fetch(request, env), so the Worker's bindings (#26) are a
  // global, without the kernel's own.
  const { UNSAFE, TOKEN, META, ...bindings } = env;
  globalThis.env = bindings;
  // workerd forbids eval without its UnsafeEval binding; celld (#25) allows
  // a plain global eval and has no such binding.
  const evaluate = env.UNSAFE ? (code) => env.UNSAFE.eval(code, "cell") : (code) => (0, eval)(code);
  handle = createHandler(globalThis.__cdpk, evaluate);
  return evaluate;
}

let evaluate = null;

/** Evaluates the bundles a cell brings, once each. */
async function loadModules(bundles = {}) {
  for (const [specifier, script] of Object.entries(bundles)) {
    if (modules.has(specifier)) continue;
    const loading = Promise.resolve().then(() => evaluate(script));
    // A module that failed to load is retried by the next import of it.
    loading.catch(() => modules.delete(specifier));
    modules.set(specifier, loading);
  }
}

async function answer(req) {
  if (req.op === "info") {
    return {
      v8: globalThis.process?.versions?.v8 ?? "",
      bindings: Object.keys(globalThis.env),
      // A Workers project's default export (src/workers-project.ts).
      worker: globalThis.worker !== undefined,
    };
  }
  if (req.op === "eval") await loadModules(req.modules);
  return await handle(req);
}

export default {
  async fetch(request, env) {
    // A header, or the query string for a WebSocket client that can't set
    // headers (celld's session uses the host's built-in WebSocket).
    const token = request.headers.get("x-cdpk-token") ?? new URL(request.url).searchParams.get("token");
    if (token !== env.TOKEN) return new Response("forbidden", { status: 403 });
    if (request.headers.get("upgrade") !== "websocket") return new Response("expected a WebSocket", { status: 426 });
    evaluate ??= install(env);

    // The session: every request from the host arrives as a message, and
    // all of them run in this one request's IoContext. So I/O objects (a
    // Durable Object stub, a stream) made in one cell work in the next, and
    // work a cell leaves running outlives it (#26).
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    const send = (line) => {
      try {
        server.send(line);
      } catch {
        // The host is gone.
      }
    };
    sink = send;
    for (const line of outbox.splice(0)) send(line);
    server.addEventListener("message", (event) => {
      const req = JSON.parse(event.data);
      answer(req).then(
        (reply) => send(JSON.stringify({ kind: "reply", id: req.id, ...reply })),
        (err) => send(JSON.stringify({ kind: "reply", id: req.id, failure: String(err?.stack ?? err) })),
      );
    });
    server.addEventListener("close", () => {
      if (sink === send) sink = null;
    });
    return new Response(null, { status: 101, webSocket: client });
  },
};
