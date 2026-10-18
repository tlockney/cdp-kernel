# The browser (experimental)

The kernel can run inside a web page, with cells in a Web Worker and no
server or Jupyter install. It is a proof of concept: there is no package
export, kernelspec or frontend for it yet, and it isn't covered by the
[support policy](support.md).

## How it fits

The kernel's message handling, `KernelCore` in `src/kernel-core.ts`, has
no Node imports. It talks to frontends through a `KernelChannels`
transport and runs cells on a `KernelTarget`. The kernel process
(`src/kernel.ts`) gives it ZeroMQ (`src/zmq-channels.ts`) and the runtimes
in [Runtime integrations](integrations.md). In a page,
`src/browser/mod.ts` gives it:

- **`PageChannels`** (`src/browser/channels.ts`): the frontend calls
  `send(channel, msg)` with messages in Jupyter's JSON shape (`header`,
  `parent_header`, `metadata`, `content`, `buffers`), the shape the
  websocket's JSON protocol and `@jupyterlab/services` use, and gets
  every reply, iopub and stdin message through `onMessage`. There is no
  signing: the frontend and the kernel share a page.
- **`BrowserTarget`** (`src/browser/target.ts`): a module Worker that the
  page creates, running `runtime/browser-worker.mjs`. Requests and replies
  are messages in the same shape as the [workerd driver's
  session](integration-workers.md), and cells are transformed the same way
  (`transformCellForEval`), so they run as global code and their
  declarations persist.

The Worker loads the same `display.mjs`, `comm.mjs`, `widget.mjs`,
`introspect.mjs` and `evaluator.mjs` as the other targets.
`runtime/format.mjs` stands in for `util.inspect` and `util.format`.

## Use

```sh
node scripts/build-browser.mjs dist/browser   # kernel.js and worker.js
```

```js
import { startBrowserKernel } from "./kernel.js";

const kernel = startBrowserKernel({
  createWorker: () => new Worker("./worker.js", { type: "module" }),
});
kernel.onMessage((channel, msg) => console.log(channel, msg.header.msg_type, msg.content));
kernel.send("shell", {
  header: { msg_id: crypto.randomUUID(), msg_type: "execute_request", session: "s", username: "", date: new Date().toISOString(), version: "5.3" },
  parent_header: {},
  metadata: {},
  content: { code: "const x: number = 21; x * 2", silent: false, store_history: true, allow_stdin: false, stop_on_error: true },
});
```

`test/browser.test.ts` runs a page like this in headless Chromium.

## What works

- TypeScript and TSX, stripped by sucrase (esbuild's native binary can't
  run in a page), top-level `await`, and state from cell to cell.
- `console` output, the `jupyter` display namespace, rich results, errors
  with their stack, comms, completion from runtime values, and inspection.
- Imports. Relative imports and URLs load as they are. `npm:`, `jsr:` and
  bare package names load from a CDN, esm.sh by default (the `cdn`
  option): `npm:date-fns@4` becomes `https://esm.sh/date-fns@4`, and
  `jsr:@std/path` becomes `https://esm.sh/jsr/@std/path`.
- Interrupt. A cell waiting on a promise is abandoned and the Worker keeps
  its state, as on workerd. A busy cell can't be stopped in place, so the
  Worker is terminated and a new one starts on the next cell, without the
  earlier cells' state.

## Not yet

- `prompt()` and `confirm()` answer as when the frontend has no stdin. A
  synchronous prompt in a Worker needs `SharedArrayBuffer` and
  `Atomics.wait`, so a cross-origin isolated page (COOP and COEP headers).
- Typed completion. The language service runs in a browser, but
  `src/language-service-worker.ts` reads its lib files from disk and
  installs `@types` packages with npm.
- The visual debugger: a page has no CDP.
- `Deno.*` and Node's builtins, beyond what esm.sh polyfills for `node:`
  imports.
- Files: `jupyter.image(path)` has no file system to read.
- A frontend. The kernel speaks the message protocol; a page still needs
  something to show it, such as a JupyterLite kernel wrapper or
  [Ganymede](https://ganymede-server.com/)'s engine in the page.
