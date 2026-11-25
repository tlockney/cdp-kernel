# The browser

The kernel can run inside a web page, with cells in a Web Worker and no
server or Jupyter install. It is an npm export, not a kernelspec: a page
starts it and supplies the frontend. The
[Ganymede](https://ganymede-server.com) apps for Mac, iPad and iPhone run
their in-app kernel this way. The [support policy](support.md#runtimes)
says which browser engines CI covers.

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

![The page runs the frontend, PageChannels, KernelCore and BrowserTarget. The frontend calls send and gets messages through onMessage; KernelCore runs cells through BrowserTarget, which exchanges postMessage requests and replies with a module Worker running runtime/browser-worker.mjs. The Worker loads npm: and jsr: imports from a CDN, esm.sh by default.](images/integrations/browser-target.svg)

The Worker loads the same `display.mjs`, `comm.mjs`, `widget.mjs`,
`introspect.mjs` and `evaluator.mjs` as the other targets.
`runtime/format.mjs` stands in for `util.inspect` and `util.format`.

## Use

From npm, with a bundler that handles worker imports (Vite: `?worker&url`):

```js
import { startBrowserKernel } from "@tlockney/cdp-kernel/browser";
import workerUrl from "@tlockney/cdp-kernel/browser/worker?worker&url";

const kernel = startBrowserKernel({
  createWorker: () => new Worker(workerUrl, { type: "module" }),
});
```

`@tlockney/cdp-kernel/browser` is `dist/browser/kernel.js`,
`.../browser/worker` is `dist/browser/worker.js` and
`.../browser/language-worker` is `dist/browser/language-worker.js`, all from
`scripts/build-browser.mjs`, which `npm run build` runs. Not on JSR yet.
From a checkout:

```sh
node scripts/build-browser.mjs dist/browser   # kernel.js, worker.js and language-worker.js
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

`test/browser.test.ts` and `test/browser-typescript.test.ts` run a page
like this in headless Chromium, WebKit and Firefox, through Playwright;
CI runs them in all three. Safari itself,
on macOS or iOS, isn't tested.

## Host features

A page that embeds the kernel, such as an app's WebView, can offer cells
features of its own (#384). Three options to `startBrowserKernel`, all
optional:

- **`preload`**: module URLs the Worker imports before the first cell,
  each time it starts (so again after a restart), resolved against
  `base`. A module whose default export is a function has it called with
  `{ host, jupyter }`. A module that fails to load is reported on stderr
  and the kernel runs without it.
- **`host`**: answers the Worker's requests. In a preload module,
  `host.request(method, params, { signal, transfer })` resolves with what
  the handler returns, or rejects with an `Error` carrying the thrown
  error's `name`, `message` and `code`. The handler gets an `AbortSignal`
  that aborts when the Worker aborts the call or stops, and on every
  interrupt: an interrupt cancels each request in flight, and its
  `host.request` promise rejects with an `AbortError`. Values cross by
  structured clone.
- **`capabilities`**: returned as `capabilities` in `kernel_info_reply`,
  so a frontend can see what the page offers.

`kernel.notifyHost(event, value)` sends an event to the Worker's
`host.onEvent((event, value) => …)` listeners. Cells only see what a
preload module chooses to install, for example a global:

```js
// device.mjs, listed in preload
export default function ({ host }) {
  globalThis.device = {
    clipboard: { readText: () => host.request("clipboard.readText", {}) },
  };
}
```

```js
const kernel = startBrowserKernel({
  createWorker: () => new Worker(workerUrl, { type: "module" }),
  preload: [new URL("./device.mjs", import.meta.url).href],
  host: async ({ method }) => {
    if (method === "clipboard.readText") return await navigator.clipboard.readText();
    throw Object.assign(new Error(`no ${method}`), { code: "unavailable" });
  },
  capabilities: { device: ["clipboard.readText"] },
});
```

## TypeScript language service

Typed completion and tooltips (declared types, where the runtime knows
only values), type errors through the `cdp-kernel.diagnostics.v1` comm,
and signature help, definition and rename through `cdp-kernel.language.v1`
([notebooks](notebooks.md#type-errors-for-frontends)) need TypeScript,
which the kernel doesn't carry: it is 9 MB, and TypeScript's lib files
add more. A page that wants them passes the `typescript` option with
files it serves:

```js
const kernel = startBrowserKernel({
  createWorker: () => new Worker(workerUrl, { type: "module" }),
  typescript: {
    // dist/browser/language-worker.js, `@tlockney/cdp-kernel/browser/language-worker`
    createWorker: () => new Worker(languageWorkerUrl, { type: "module" }),
    module: "/vendor/typescript/typescript.js", // TypeScript 6's lib/typescript.js
    libs: "/vendor/typescript/lib/", // its lib.*.d.ts files
    runtimeTypes: "/vendor/cdp-kernel/runtime/", // the package's runtime/*.d.mts, optional
  },
});
```

- **`module`** is `lib/typescript.js` from the `typescript` package,
  version 6. The Worker fetches it and runs it with `new Function`, so a
  page whose Content Security Policy forbids `unsafe-eval` can't use the
  option. The URL is resolved against `typescript.base`, else the
  target's `base`.
- **`libs`** is a directory that serves the package's `lib.*.d.ts` files
  under their names. The Worker fetches `lib.esnext.d.ts` and the files
  it references, 87 of them in TypeScript 6.0.3. Serve the package's
  `lib/` as it is, or just those files.
- **`runtimeTypes`** is a directory that serves the kernel package's
  `runtime/*.d.mts` files, which type `jupyter` (`display.d.mts` and
  what it imports, 6 files). Without it, or if they don't load,
  `jupyter` is `any`.
- **`createWorker`** makes the language service's own Web Worker, so
  parsing and checking never block cells, the page or the kernel's
  replies.
- **`budgetMs`** is how long a request waits for the Worker, 500 by
  default.

The Worker starts on the first completion, tooltip or comm request, not
with the kernel, and the page pays for the files only then. TypeScript
takes a moment to load (about a second); until it has, the kernel
answers from the runtime as it does without the option, and the comms
answer `null`, which frontends read as "can't tell". The Worker is
ended when the kernel shuts down, and after ten minutes without a request; a later request starts a new
one with the cells that have run. `language_info.version` in
`kernel_info_reply` is the TypeScript the Worker loaded.

Without the option nothing changes: completion comes from the runtime,
no Worker is made, and a frontend's request to open either comm is closed.

The service checks cells against ES libs (`lib.esnext.d.ts` and its 87
files; 621 KB, 116 KB gzipped file by file, as a server sends them) plus declarations in the kernel for
what a cell in a Worker reaches for: `console`, timers, `fetch` with its
`Request`, `Response`, `Headers`, `URL`, `AbortController` and
`TextEncoder`, among others (12 KB, 3 KB gzipped, in
`src/browser/language-globals.ts`). `WebAssembly`, `navigator`,
`ReadableStream`, `WebSocket`, `FormData`, `Event`, `MessageChannel` and
a few more are declared loosely, so using them is not an error.
It doesn't load `lib.dom.d.ts` (2.3 MB) or `lib.webworker.d.ts`
(787 KB). A Worker global the
declarations leave out is an error in the diagnostics although the Worker
has it; it can be added to that file. The `jupyter` types are 51 KB (17 KB
gzipped file by file). TypeScript itself is 9.1 MB (1.6 MB gzipped).

An import of a package is `any`: the language service doesn't fetch
types for `npm:` or esm.sh imports, and doesn't report them as errors.
A relative import that isn't served to the language service is an error
(there are no files to resolve it from).

## What works

- TypeScript and TSX, stripped by sucrase (esbuild's native binary can't
  run in a page), top-level `await`, and state from cell to cell.
- `console` output, the `jupyter` display namespace, rich results, errors
  with their stack, comms, completion from runtime values, and inspection.
- Imports. Relative imports and URLs load as they are. `npm:`, `jsr:` and
  bare package names load from a CDN, esm.sh by default (the `cdn`
  option): `npm:date-fns@4` becomes `https://esm.sh/date-fns@4`, and
  `jsr:@std/path` becomes `https://esm.sh/jsr/@std/path`.
- Imports the page serves itself. The `modules` option maps specifiers,
  exactly as written, to URLs, and they win over the CDN. A page can ship
  the packages [`jupyter.chart`](jupyter-api.md#charts) loads, named by
  `CHART_MODULES`, so charts draw offline:

  ```js
  import { CHART_MODULES, startBrowserKernel } from "@tlockney/cdp-kernel/browser";
  const kernel = startBrowserKernel({
    createWorker: () => new Worker(workerUrl, { type: "module" }),
    modules: {
      [CHART_MODULES.vega]: new URL("./vendor/vega.mjs", location.href).href,
      [CHART_MODULES.vegaLite]: new URL("./vendor/vega-lite.mjs", location.href).href,
      [CHART_MODULES.linkedom]: new URL("./vendor/linkedom.mjs", location.href).href,
    },
  });
  ```

  Each URL serves an ES module that exports what the package does. A
  cell's own `import "npm:vega@6"` loads the mapped copy too.

  `SQL_MODULES` does the same for [`jupyter.sql`](jupyter-api.md#sql-with-duckdb):
  `duckdb` is an ES module of @duckdb/duckdb-wasm, and the `eh` and
  `mvp` pairs are that package's `dist/` wasm and worker files, served
  as they are, the wasm as `application/wasm`. A pair counts only when
  both of its files are mapped; one left out, or half mapped, loads from
  jsDelivr. Current browsers all run `eh`, so mapping `eh` is enough,
  and `mvp` alone never takes effect there. If DuckDB's worker can't
  load (offline, with the files neither mapped nor cached), the query
  fails with that error, and the next `jupyter.sql` call tries again.
- Typed completion, tooltips, type errors and signature help, definition
  and rename, when the page opts in ([TypeScript language
  service](#typescript-language-service)).
- Interrupt. A cell waiting on a promise is abandoned and the Worker keeps
  its state, as on workerd, and
  [`jupyter.signal`](jupyter-api.md#stopping-on-interrupt-jupyter-signal)
  is aborted. A busy cell can't be stopped in place, so the
  Worker is terminated and a new one starts on the next cell, without the
  earlier cells' state. The stderr note it prints carries metadata a
  frontend can check ([Telling a frontend the state is
  gone](integrations.md#telling-a-frontend-the-state-is-gone)).

## Not yet

- `prompt()` and `confirm()` answer as when the frontend has no stdin. A
  synchronous prompt in a Worker needs `SharedArrayBuffer` and
  `Atomics.wait`, so a cross-origin isolated page (COOP and COEP headers).
- Types for packages. In the browser's language service an import from
  esm.sh or `npm:` is `any`, without an error; fetching the package's
  types is not done yet
  ([#525](https://github.com/tlockney/cdp-kernel/issues/525)).
- The visual debugger: a page has no CDP.
- `Deno.*` and Node's builtins, beyond what esm.sh polyfills for `node:`
  imports.
- Files: `jupyter.image(path)` has no file system to read.
- A frontend of its own. The kernel speaks the message protocol; a page
  still needs something to show it.
  [ganymede-ui](https://github.com/tlockney/ganymede-ui) is one: it wraps
  the kernel for JupyterLite's in-page server, in a browser and in the
  Ganymede Mac and iPad apps.
