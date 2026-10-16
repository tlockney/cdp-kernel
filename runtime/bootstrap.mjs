// Entry module for the target runtime. The kernel host launches
//   node --inspect=127.0.0.1:0 runtime/bootstrap.mjs
//   deno run -A --inspect=127.0.0.1:0 runtime/bootstrap.mjs
// then drives it over CDP. Everything the host needs from inside the
// runtime lives on globalThis.__cdpk; output to the host goes through the
// `__cdpk_send` CDP binding (Runtime.addBinding) plus plain stdout/stderr.
// Bun is launched as `bun runtime/bootstrap.mjs` and driven over a pipe
// instead; see bun-channel.mjs.
//
// Plain JavaScript on purpose: the same file must load unmodified in Node,
// Deno and Bun.

import { fileURLToPath, pathToFileURL } from "node:url";
import { createJupyter } from "./display.mjs";
import { describeValue, inspectPath, resolvePath } from "./introspect.mjs";

const isDeno = typeof globalThis.Deno?.version?.deno === "string";
const isBun = typeof globalThis.Bun?.version === "string";
const ENC = new TextEncoder();

const cwd = isDeno ? Deno.cwd() : process.cwd();
// pathToFileURL, not string concatenation: a directory name containing
// "#", "?" or "%" would otherwise cut the path short or turn into a query,
// breaking relative imports and import.meta (#22). It also handles Windows
// drive letters.
const cwdUrl = pathToFileURL(cwd.endsWith("/") ? cwd : cwd + "/");
// Stand-in referrer for cell code, like Deno's ./$deno$jupyter_repl.mts.
const replUrl = new URL("$cdpk$repl.mjs", cwdUrl);

const { inspect, inspectPlain, readFile, writeOut, writeErr, readStdinLine } = await platform();

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
  // Serialize before writing the marker: if the payload can't be
  // serialized (a BigInt, a cycle), the error reaches the cell without a
  // gated marker the host would wait on forever (#129). `payload` always
  // has a `kind`, so `body` is never "{}".
  const body = JSON.stringify(payload);
  binding(`{"barrier":${barrier(true)},${body.slice(1)}`);
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
    if (reply.interrupted === true) {
      // Interrupted while waiting for the answer: unwind the cell, as
      // KeyboardInterrupt does in Python's input() (#121).
      const err = new Error("Execution interrupted");
      err.name = "Interrupted";
      throw err;
    }
    return typeof reply.value === "string" ? reply.value : null;
  },
});

// --- Module loading -------------------------------------------------------
function resolveRelative(specifier) {
  return /^\.{0,2}\//.test(specifier) ? new URL(specifier, replUrl).href : specifier;
}

if (!isDeno && !isBun) {
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

// Bun has neither npm: nor jsr:, and would resolve a bare name from this
// file's directory. npm:/jsr: install into a per-user cache as on Node
// (with `bun add`); anything else bare resolves from the notebook's
// directory, so its node_modules, or Bun's auto-install, supplies it.
const packages = isBun ? await import("./node-hooks.mjs") : null;

function bunResolve(specifier) {
  let pkg = null;
  if (specifier.startsWith("npm:")) pkg = packages.parsePackageSpecifier(specifier.slice(4));
  else if (specifier.startsWith("jsr:")) pkg = packages.jsrToNpm(specifier.slice(4));
  if (pkg) {
    const { dir, alias } = packages.ensureInstalled(pkg, "bun", { lockFile: packages.findLockFile(cwd) });
    return Bun.resolveSync(alias + pkg.subpath, dir);
  }
  // Relative, absolute, or a URL scheme such as node:, bun: or file:.
  if (/^(?:\.{0,2}\/|[a-z][a-z0-9+.-]*:)/i.test(specifier)) return resolveRelative(specifier);
  return Bun.resolveSync(specifier, cwd);
}

// The inspector holds a promise it awaits (callFunctionOn with awaitPromise)
// only weakly until its then-callback runs, so a GC after the promise
// settles but before that callback fails the call with "Promise was
// collected" (#55). hold() keeps the promise until a macrotask after it
// settles, by which time the inspector's callback has run.
const held = new Set();
function hold(value) {
  const promise = Promise.resolve(value);
  held.add(promise);
  const release = () => setTimeout(() => held.delete(promise), 0);
  promise.then(release, release);
  return promise;
}

// Adds the cause to an error from a Deno member the --deno-compat shim
// lacks (#172); the identity everywhere else.
let explainError = (text) => text;

globalThis.__cdpk = {
  // Cell code awaits this first; see PRELUDE in src/transform.ts.
  tick: () => new Promise((resolve) => setTimeout(resolve, 0)),
  // Node: the resolve hook re-parents these imports. Deno would resolve
  // relative paths against this file, so denoImport does it here.
  import: (specifier, options) =>
    isDeno
      ? denoImport(specifier, options)
      : isBun
      ? import(bunResolve(specifier), options)
      : import(specifier, options),
  meta: {
    url: replUrl.href,
    dirname: cwd,
    filename: fileURLToPath(replUrl),
    resolve: (specifier) => new URL(specifier, replUrl).href,
  },
  barrier,
  hold,
  // inspect_request (#10). CDP targets find the value with
  // throwOnSideEffect and describe it here; Bun resolves the path here
  // too, by descriptor, so nothing runs.
  describeForInspect: (value, detail) => describeValue(value, { inspect: inspectPlain, detail }),
  inspectPath: (path, detail) => inspectPath(path, { inspect: inspectPlain, detail }),
  resolvePath,
  broadcastResult: jupyter.broadcastResult,
  // The debugger's rich variable viewer (#18), synchronously: it runs while
  // the target is paused. A value whose $display is async shows as text.
  richBundle(value) {
    const bundle = jupyter.formatNow(value);
    return JSON.stringify(typeof bundle?.then === "function" ? { "text/plain": inspectPlain(value) } : bundle);
  },
  // Frontend comm messages (#9), from the host's shell channel. Handlers
  // run after one macrotask, like cells, so interrupt can reach them.
  async commDispatch(msgType, content, metadata, buffers64) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const buffers = buffers64.map((b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
    return await jupyter.commDispatch(msgType, content, metadata, buffers);
  },
  describeError(value) {
    if (value instanceof Error) {
      const message = explainError(value.message);
      const stack = stackOf(value).replace(value.message, () => message);
      return JSON.stringify({ name: value.name, message, stack });
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
  // itself is configurable, so swap in an object with its own `jupyter`
  // that inherits everything else from the real namespace. Not a Proxy:
  // completion can't list a Proxy's properties, and Shift-Tab's
  // side-effect-free evaluation can't read through one (#132). So
  // Object.keys(Deno) and console.log(Deno) show only `jupyter`, and
  // Deno's functions are called with `this` set to this object (they
  // don't use it).
  const real = globalThis.Deno;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Deno");
  const shim = Object.create(real, {
    jupyter: { value: jupyter.namespace, enumerable: true, configurable: true, writable: true },
  });
  Object.defineProperty(globalThis, "Deno", { ...descriptor, value: shim });
} else if (process.env.CDPK_DENO_COMPAT === "1" && globalThis.Deno === undefined) {
  // Opt-in (install --deno-compat): a Deno namespace for notebooks written
  // against `deno jupyter`. See runtime/deno-compat.mjs for the trade-off.
  // Absolute URL: the resolve hook re-parents this module's relative
  // imports to the notebook directory.
  const { createDenoShim, explainMissing } = await import(new URL("./deno-compat.mjs", import.meta.url).href);
  const shim = createDenoShim({ jupyter: jupyter.namespace });
  globalThis.Deno = shim;
  explainError = (text) => explainMissing(text, shim);
}

/**
 * An error's stack, with its first line naming the error. Bun now and then
 * (about one throw in twenty, #216) records a stack whose first line is a
 * bare "Error", though name and message are set; the frames are right, so
 * only the header is rebuilt.
 */
function stackOf(err) {
  const stack = err.stack;
  if (typeof stack !== "string") return "";
  const nl = stack.indexOf("\n");
  const first = nl === -1 ? stack : stack.slice(0, nl);
  if (first !== "Error" || !err.message) return stack;
  return `${err.name}: ${err.message}${nl === -1 ? "" : stack.slice(nl)}`;
}

// An error thrown later by a cell's timer or promise must not kill the kernel.
function reportUncaught(kind, err) {
  writeErr(`${kind}: ${explainError(err instanceof Error ? (stackOf(err) || err.message) : inspect(err))}\n`);
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

// A host killed by SIGKILL can't stop its runtime, and nothing visible to
// JS here changes when its inspector sessions drop, so watch for the host
// itself going: reparented, or no longer there (#219). Bun exits on its
// channel's EOF instead.
if (!isBun) {
  // Held here, so a cell that reassigns them can't break the watch.
  const proc = process;
  const exit = process.exit.bind(process);
  const host = proc.ppid;
  const hostGone = () => {
    if (proc.ppid !== host) return true;
    try {
      proc.kill(host, 0);
      return false;
    } catch (err) {
      return err?.code === "ESRCH";
    }
  };
  setInterval(() => {
    if (hostGone()) exit(1);
  }, 2000);
}

if (isBun) {
  const { startChannel } = await import("./bun-channel.mjs");
  const { createHandler } = await import("./evaluator.mjs");
  startChannel(createHandler(globalThis.__cdpk), {
    versions: { runtime: Bun.version, engine: `JavaScriptCore (WebKit ${process.versions.webkit.slice(0, 12)})` },
  });
}

async function platform() {
  if (isDeno) {
    const stdinBuf = new Uint8Array(1);
    return {
      inspect: (v) => Deno.inspect(v, { colors: true, depth: 4 }),
      inspectPlain: (v) => Deno.inspect(v, { colors: false, depth: 2 }),
      readFile: (p) => Deno.readFileSync(p),
      writeOut: (s) => Deno.stdout.writeSync(ENC.encode(s)),
      writeErr: (s) => Deno.stderr.writeSync(ENC.encode(s)),
      readStdinLine: () => readLine(() => (Deno.stdin.readSync(stdinBuf) ? stdinBuf[0] : null)),
    };
  }
  const util = await import("node:util");
  const fs = await import("node:fs");
  const buf = Buffer.alloc(1);
  // Node writes to a pipe without blocking and queues what doesn't fit for
  // the event loop to flush. input() blocks the main thread in readSync, so
  // queued output, and the input_request's barrier marker after it, would
  // never reach the host (#131). Blocking writes finish before readSync
  // starts, as Node already does on Windows. Bun has no _handle and needs
  // its own fix (#180).
  if (isBun) await syncBunOutput();
  else for (const stream of [process.stdout, process.stderr]) stream._handle?.setBlocking?.(true);
  return {
    inspect: (v) => util.inspect(v, { colors: true, depth: 4 }),
    inspectPlain: (v) => util.inspect(v, { colors: false, depth: 2 }),
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

// Bun makes stdout and stderr non-blocking once process.stdout or
// process.stderr exists, and then queues what doesn't fit in the pipe for
// its event loop, console.log's output included. input() blocks the main
// thread in readSync, so queued output, and the input_request's barrier
// marker after it, would never reach the host (#180). Here every write
// finishes before it returns: process.stdout.write and process.stderr.write
// write through, and console is Node's Console over them, so console output
// is formatted as on Node.
async function syncBunOutput() {
  const { writeAll } = await import("./bun-channel.mjs");
  const { Console } = await import("node:console");
  for (const [stream, fd] of [[process.stdout, 1], [process.stderr, 2]]) {
    stream.write = (chunk, encoding, callback) => {
      if (typeof encoding === "function") [callback, encoding] = [encoding, undefined];
      writeAll(fd, typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk);
      if (callback) process.nextTick(callback);
      return true;
    };
  }
  const sync = new Console({ stdout: process.stdout, stderr: process.stderr, colorMode: true });
  for (const key of Object.keys(console)) {
    if (typeof sync[key] === "function") console[key] = sync[key].bind(sync);
  }
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
