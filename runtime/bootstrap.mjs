// Entry module for the target runtime. The kernel host launches
//   node --inspect=127.0.0.1:0 runtime/bootstrap.mjs
//   deno run -A --inspect=127.0.0.1:0 runtime/bootstrap.mjs
// then drives it over CDP. Everything the host needs from inside the
// runtime lives on globalThis.__cdpk; output to the host goes through the
// `__cdpk_send` CDP binding (Runtime.addBinding) plus plain stdout/stderr.
//
// Plain JavaScript on purpose: the same file must load unmodified in Node
// and in Deno.

import { createJupyter } from "./display.mjs";

const isDeno = typeof globalThis.Deno?.version?.deno === "string";
const ENC = new TextEncoder();

const cwd = isDeno ? Deno.cwd() : process.cwd();
const cwdUrl = new URL(`file://${cwd.endsWith("/") ? cwd : cwd + "/"}`);
// Stand-in referrer for cell code, like Deno's ./$deno$jupyter_repl.mts.
const replUrl = new URL("$cdpk$repl.mjs", cwdUrl);

const { inspect, readFile, writeOut, writeErr, readStdinLine } = await platform();

function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// --- Output ordering ----------------------------------------------------
// stdout/stderr reach the host over pipes; display messages over the
// WebSocket. To keep them in order, every binding message is preceded by a
// numbered marker written to both pipes. The host holds the message until
// both pipes have delivered that marker, and a gated marker ("m") holds
// later pipe output until the message has gone out.
let barrierSeq = 0;
function barrier(gated = false) {
  const n = ++barrierSeq;
  const marker = `\x1b[cdpk:${n}${gated ? "m" : ""}]\x1b`;
  writeOut(marker);
  writeErr(marker);
  return n;
}

function send(payload) {
  const binding = globalThis.__cdpk_send;
  if (typeof binding !== "function") return; // host not attached yet
  binding(JSON.stringify({ ...payload, barrier: barrier(true) }));
}

const jupyter = createJupyter({
  inspect: (value) => inspect(value),
  base64,
  readFile,
  send(msgType, content, metadata, buffers) {
    send({ kind: "iopub", msg_type: msgType, content, metadata, buffers: buffers.map(base64) });
  },
  // Synchronous like Deno's op_jupyter_input: ask the host, then block on
  // stdin for its JSON-line reply.
  input(prompt, password) {
    send({ kind: "input_request", prompt, password });
    const line = readStdinLine();
    if (line === null) return null;
    const reply = JSON.parse(line);
    return typeof reply.value === "string" ? reply.value : null;
  },
});

// --- Module loading -------------------------------------------------------
function resolveRelative(specifier) {
  return /^\.{0,2}\//.test(specifier) ? new URL(specifier, replUrl).href : specifier;
}

if (!isDeno) {
  // Deno resolves npm:/jsr: natively; Node gets a resolve hook that adds
  // them and re-parents cell imports to the notebook's directory.
  const { installNodeResolveHooks } = await import("./node-hooks.mjs");
  installNodeResolveHooks({ shimUrl: import.meta.url, replUrl: replUrl.href });
}

// In a Deno project (#13), Deno's own resolution (import map, npm:, jsr:)
// goes first, as in `deno jupyter`. A bare package it can't place, because
// package.json dependencies resolve relative to *this* module rather than
// the notebook, is retried from the project's node_modules.
const inDenoProject = isDeno && Deno.env.get("CDPK_DENO_PROJECT") === "1";
const { resolveFromNodeModules } = inDenoProject ? await import("./node-modules-resolve.mjs") : {};

function isResolutionError(err, specifier) {
  return err instanceof TypeError && err.message.includes(`"${specifier}"`);
}

async function denoImport(specifier, options) {
  const resolved = resolveRelative(specifier);
  try {
    return await import(resolved, options);
  } catch (err) {
    const fromNodeModules = resolveFromNodeModules && isResolutionError(err, specifier)
      ? resolveFromNodeModules(specifier, cwd)
      : null;
    if (fromNodeModules === null) throw err;
    return await import(fromNodeModules, options);
  }
}

globalThis.__cdpk = {
  // Cell code awaits this first; see PRELUDE in src/transform.ts.
  tick: () => new Promise((resolve) => setTimeout(resolve, 0)),
  // Node: the resolve hook re-parents these imports. Deno would resolve
  // relative paths against this file, so denoImport does it here.
  import: (specifier, options) => (isDeno ? denoImport(specifier, options) : import(specifier, options)),
  meta: {
    url: replUrl.href,
    dirname: cwd,
    filename: replUrl.pathname,
    resolve: (specifier) => new URL(specifier, replUrl).href,
  },
  barrier,
  broadcastResult: jupyter.broadcastResult,
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
if (isDeno) {
  // Existing Deno notebooks use Deno.jupyter, but outside `deno jupyter`
  // that is a non-configurable getter that throws. The global binding
  // itself is configurable, so swap in a proxy that answers `jupyter` and
  // forwards everything else to the real namespace.
  const real = globalThis.Deno;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Deno");
  const proxy = new Proxy(real, {
    get: (target, key) => (key === "jupyter" ? jupyter.namespace : Reflect.get(target, key, target)),
  });
  Object.defineProperty(globalThis, "Deno", { ...descriptor, value: proxy });
} else if (process.env.CDPK_DENO_COMPAT === "1" && globalThis.Deno === undefined) {
  // Opt-in (install --deno-compat): a Deno namespace for notebooks written
  // against `deno jupyter`. See runtime/deno-compat.mjs for the trade-off.
  // Absolute URL: the resolve hook re-parents this module's relative
  // imports to the notebook directory.
  const { createDenoShim } = await import(new URL("./deno-compat.mjs", import.meta.url).href);
  globalThis.Deno = createDenoShim({ jupyter: jupyter.namespace });
}

// An error thrown later by a cell's timer or promise must not kill the kernel.
function reportUncaught(kind, err) {
  writeErr(`${kind}: ${err instanceof Error ? (err.stack ?? err.message) : inspect(err)}\n`);
}
if (isDeno) {
  globalThis.addEventListener("unhandledrejection", (e) => {
    e.preventDefault();
    reportUncaught("Uncaught (in promise)", e.reason);
  });
  globalThis.addEventListener("error", (e) => {
    e.preventDefault();
    reportUncaught("Uncaught", e.error);
  });
} else {
  process.on("unhandledRejection", (err) => reportUncaught("Uncaught (in promise)", err));
  process.on("uncaughtException", (err) => reportUncaught("Uncaught", err));
}

// Keep the event loop alive between cells.
setInterval(() => {}, 1 << 30);

async function platform() {
  if (isDeno) {
    const stdinBuf = new Uint8Array(1);
    return {
      inspect: (v) => Deno.inspect(v, { colors: true, depth: 4 }),
      readFile: (p) => Deno.readFileSync(p),
      writeOut: (s) => Deno.stdout.writeSync(ENC.encode(s)),
      writeErr: (s) => Deno.stderr.writeSync(ENC.encode(s)),
      readStdinLine: () => readLine(() => (Deno.stdin.readSync(stdinBuf) ? stdinBuf[0] : null)),
    };
  }
  const util = await import("node:util");
  const fs = await import("node:fs");
  const buf = Buffer.alloc(1);
  return {
    inspect: (v) => util.inspect(v, { colors: true, depth: 4 }),
    readFile: (p) => fs.readFileSync(p),
    writeOut: (s) => process.stdout.write(s),
    writeErr: (s) => process.stderr.write(s),
    readStdinLine: () =>
      readLine(() => {
        for (;;) {
          try {
            return fs.readSync(0, buf, 0, 1, null) === 1 ? buf[0] : null;
          } catch (err) {
            if (err.code !== "EAGAIN") throw err;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
      }),
  };
}

function readLine(nextByte) {
  const bytes = [];
  for (;;) {
    const byte = nextByte();
    if (byte === null) return bytes.length ? new TextDecoder().decode(new Uint8Array(bytes)) : null;
    if (byte === 0x0a) return new TextDecoder().decode(new Uint8Array(bytes));
    bytes.push(byte);
  }
}
