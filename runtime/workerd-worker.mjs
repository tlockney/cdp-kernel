// The driver Worker for the workerd target (#8).
//
// workerd's inspector can evaluate code, but outside a request there is no
// IoContext: timers, fetch and crypto.randomUUID throw "Disallowed operation
// called within global scope". So every host request is an HTTP request to
// this Worker, over a Unix socket only the host can reach, and runs inside
// that request. The cell code itself comes from transformCellForEval and is
// run by the UnsafeEval binding as global code, so its declarations persist
// across requests (see evaluator.mjs).
//
// The response is a stream of JSON lines: console output and iopub messages
// as they happen, then the reply. One stream per request keeps them in
// order without the barrier markers the pipe-based targets need.
//
// workerd can't load modules at runtime beyond its builtins, so the host
// bundles anything else a cell imports (src/workerd-target.ts) and sends it
// with the cell.

import { formatWithOptions, inspect } from "node:util";
import { createJupyter } from "./display.mjs";
import { createHandler } from "./evaluator.mjs";

const ENC = new TextEncoder();
const BUILTIN = /^(?:node|cloudflare|workerd):/;

function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// --- Output -----------------------------------------------------------------
// Lines go to the stream of the request running user code (a cell, a comm
// message or a result display). Anything emitted between requests, e.g. by a
// widget's timer, waits for the next one.
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
  const evaluate = (code) => env.UNSAFE.eval(code, "cell");
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

// Requests that run user code own the output stream.
const RUNS_USER_CODE = new Set(["eval", "comm", "broadcast"]);

export default {
  async fetch(request, env) {
    if (request.headers.get("x-cdpk-token") !== env.TOKEN) return new Response("forbidden", { status: 403 });
    evaluate ??= install(env);
    if (request.method === "GET") return Response.json({ v8: globalThis.process?.versions?.v8 ?? "" });

    const req = await request.json();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const write = (line) => void writer.write(ENC.encode(line + "\n")).catch(() => {});
    const own = RUNS_USER_CODE.has(req.op);
    if (own) {
      sink = write;
      for (const line of outbox.splice(0)) write(line);
    }
    (async () => {
      try {
        if (req.op === "eval") await loadModules(req.modules);
        write(JSON.stringify({ kind: "reply", ...(await handle(req)) }));
      } catch (err) {
        write(JSON.stringify({ kind: "reply", failure: String(err?.stack ?? err) }));
      } finally {
        if (own && sink === write) sink = null;
        await writer.close().catch(() => {});
      }
    })();
    return new Response(readable, { headers: { "content-type": "application/x-ndjson" } });
  },
};
