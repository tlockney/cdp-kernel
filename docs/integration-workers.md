# workerd and celld

[workerd](https://github.com/cloudflare/workerd) is the runtime behind
Cloudflare Workers, and [celld](https://github.com/denoland/celld) runs
Workers and Durable Objects on your own storage. Both run V8, but neither
can be driven like [Node and Deno](integration-cdp.md), for a reason
specific to Workers: outside a request there is no I/O context. Code
evaluated through workerd's inspector runs outside any request, so
`setTimeout`, `fetch` and `crypto.randomUUID()` throw "Disallowed operation
called within global scope".

So cells run inside a request. The kernel ships a *driver Worker*
(`runtime/workerd-worker.mjs`). The host opens one WebSocket session to it
and sends every cell over that session, and every cell runs in that one
request's I/O context. The host side is `src/workerd-target.ts`
(`WorkerdTarget`); `src/workers-project.ts` and `src/celld-target.ts` add
the ways of serving the driver. For what all runtimes share, start with
[Runtime integrations](integrations.md).

![The host's WorkerdTarget exchanges JSON messages with the driver Worker over one WebSocket session. The session runs through one of three hosts: workerd serve on a private Unix socket, a Workers project's Miniflare, or celld dev on a loopback TCP port. The host bundles each new import with esbuild and sends it with the cell.](images/integrations/workers-target.svg)

## The driver Worker

The driver is an ordinary module Worker with a `fetch` handler. When the
host connects:

1. It checks a per-launch token, from the `x-cdpk-token` header or a
   `?token=` query parameter, against its `TOKEN` binding, and answers 403
   if they differ.
2. It answers anything that isn't a WebSocket upgrade with 426.
3. On the first connection it installs the `__cdpk` shim, the `jupyter`
   namespace, `prompt`/`confirm` and `env`. (`console.log`,
   `console.error` and the rest were already replaced when the module
   loaded, with functions that send their text over the session.)
4. It creates a `WebSocketPair`, accepts the server end, and returns the
   client end with status 101.

That request never ends while the kernel runs. Each message the host
sends on it is handled inside the request's I/O context, so:

- Cells get Workers' `fetch`, `Request`, `caches`, timers and randomness.
- Anything a cell creates carries over to the next cell: globals, a
  Durable Object stub, an open stream, a timer that's still pending.

The driver's other bindings, `TOKEN` and `META` (the notebook's
`import.meta` values) and on workerd `UNSAFE`, are removed from what cells
see. Everything else becomes the global `env`, since a cell has no
`fetch(request, env)` of its own to receive it.

## The session

Both directions carry one JSON object per WebSocket message. The host
sends requests with an `id` and an `op`: the same operations as Bun's
channel (`eval`, `broadcast`, `describe`, `comm`, `props`, `inspect`,
`ping`; see [Bun](integration-bun.md#the-channel)), plus `info`, which
returns the V8 version and the names of the bindings. The driver sends
three kinds of message back:

- `{ kind: "reply", id, ... }` when a request finishes.
- `{ kind: "stream", name: "stdout" | "stderr", text }` for each `console`
  call, and on stderr for an error a cell's timer throws or a promise
  rejection nothing handles, after the cell has finished. Workers has no
  global `error` event, so the driver wraps `setTimeout`, `setInterval`
  and `queueMicrotask` callbacks to catch their errors, and the
  rejections of the promises they return, since celld doesn't dispatch
  `unhandledrejection`.
- `{ kind: "iopub", ... }` for `display()` and comm messages.

The driver hands each request to the same `runtime/evaluator.mjs` the Bun
target uses, so results are handles (`h1`, `h2`, ...) in place of CDP
object ids, and cells come from the same `transformCellForEval`: top-level
names become globals, and the cell runs in an async function for
top-level `await`. [Running a cell without replMode](integration-bun.md#running-a-cell-without-replmode)
explains that transform. The evaluator runs the script with the
`UnsafeEval` binding on workerd, since workerd forbids `eval`
otherwise, and with plain indirect `eval` on celld.

Because output, display messages and replies all travel over one socket
in order, no barrier markers are needed, and `flush()` returns at once:
by the time a cell's reply arrives, its output has arrived too.

## Imports: bundled by the host

workerd can't load a module at runtime beyond its builtins (`node:*`,
`cloudflare:*`, `workerd:*`); every other module must be part of the
Worker when it starts. So the host resolves and bundles a cell's imports
before sending the cell:

1. It finds the specifiers in the transformed cell (each
   `__cdpk.import("...")`).
2. For each one it hasn't sent before, `bundleModule` runs esbuild's
   `build()` on `import * as ns from "<specifier>"`, resolved from the
   notebook's directory, as an IIFE whose value is the namespace.
   `npm:` and `jsr:` specifiers are first installed into the npm cache,
   as on a Node target.
3. The bundle uses the conditions wrangler uses for Workers (`workerd`,
   `worker`, `browser`). Node builtins stay external. In the driver,
   `__cdpk.requireFor` imports them as `node:` modules and hands them to
   the bundle as `require`.
4. The bundles travel with the `eval` request as
   `{ code, modules: { "<specifier>": "<bundle>" } }`. The driver
   evaluates each one once and keeps the namespace promise, so later cells
   and later imports of the same specifier reuse it.

A specifier that can't be bundled becomes a bundle that rejects with
esbuild's error, so the error appears in the cell that imports it. Since a
failed bundle isn't remembered, it's rebuilt the next time, after you fix
the cause. The same holds for a module that bundles but throws while it
loads: every import of it shows that error, and the eval reply tells the
host to bundle it afresh, so the import after a fix loads the new code. TypeScript files a cell imports are compiled by esbuild as part
of the bundle, `enum` included.

## Three ways to serve the driver

The host picks how to run the driver when it launches the target:

| | workerd | Workers project (Miniflare) | celld |
|---|---|---|---|
| When | `cdp-workerd`, no wrangler config | `cdp-workerd`, `wrangler.jsonc`, `wrangler.json` or `wrangler.toml` at or above the notebook | `cdp-celld` |
| Runtime | `workerd serve` | The project's Miniflare, through its wrangler | `celld dev --no-watch` |
| Session | Unix socket in a private temp directory | Miniflare's `dispatchFetch` | Loopback TCP |
| Token | Header | Header | Query string |
| `env` | Empty | The project's bindings | The project's bindings, if a project |
| Code | `src/workerd-target.ts` (`RawWorkerd`) | `src/workers-project.ts` (`MiniflareHost`) | `src/celld-target.ts` (`CelldHost`) |

Each implements `WorkerHost`: it starts the runtime, opens the session,
reports when the runtime exits, and stops it. `WorkerdTarget` itself
doesn't know which one it has.

### Plain workerd

`RawWorkerd.start` in `src/workerd-target.ts`:

1. Finds `workerd`: the nearest `node_modules/.bin/workerd` at or above the
   notebook (a Workers project has one through wrangler), else `workerd`
   on `PATH`.
2. Reads the newest compatibility date it supports from
   `workerd --version` and uses that date. Below 2026-08-04 it also adds
   the `nodejs_compat` flag, which the driver needs for `node:util`; from
   that date the flag is on by default.
3. Creates a temporary directory with `mkdtemp`, which makes it readable
   only by the current user, and copies the driver's modules into it.
4. Writes a `config.capnp` that defines the driver Worker with these
   bindings: `UNSAFE` (`unsafeEval`), `TOKEN` and `META` (both read from
   environment variables), and outbound network access. It serves the
   driver on `unix:<dir>/sock`.
5. Runs `workerd serve config.capnp --experimental` (the `unsafeEval`
   binding is experimental) with a random 32-byte `CDPK_TOKEN`.
6. Connects to the Unix socket with a WebSocket client of its own
   (`src/ws-client.ts`), because the WebSocket built into Node and Deno
   can't connect to a Unix socket. It retries until workerd is listening.

A Unix socket in a private directory means no TCP port, so other users
can't reach the driver, and the token guards against other processes
running as you. Whatever workerd prints itself, such as its warnings, goes
to the Jupyter server log with a `[cdp-kernel workerd]` prefix; cell
output never takes that route. The directory is removed when workerd
exits, crash included. If the kernel process itself is killed first, it
stays behind in the system temp directory as `cdpk-workerd-*`.

### A Workers project, on Miniflare

If a wrangler config is at or above the notebook, `startMiniflare` in
`src/workers-project.ts` runs the driver on the project's own Miniflare,
the simulator `wrangler dev` uses, so cells get the project's bindings:

1. Loads `wrangler` from the project's `node_modules`, and the `miniflare`
   that wrangler depends on, so both match the project's versions. Neither
   is a dependency of cdp-kernel.
2. Calls wrangler's `unstable_getMiniflareWorkerOptions(configPath)`,
   which turns the config into Miniflare options: bindings, compatibility
   settings, the path of `main`, and `define`s.
3. Bundles the project's `main` with esbuild into `project.mjs`. The
   Worker's entry module re-exports `project.mjs`'s named exports, so its
   Durable Object classes run, takes its default export from the driver,
   and sets `globalThis.worker` to the project's default export.
4. Starts Miniflare with those modules, an `unsafeEvalBinding`,
   `nodejs_compat` added unless the project chose a variant, and the
   token and `META` as extra bindings. State goes to
   `.wrangler/state/cdp-kernel`, beside `wrangler dev`'s own, so the two
   never open the same Durable Object. Miniflare 5's renamed options are
   handled.
5. Opens the session with `dispatchFetch` and an `Upgrade: websocket`
   header, and uses the WebSocket in the response.

The first cell then names the bindings:

```
[cdp-kernel] Workers project /path/wrangler.jsonc: env has DB, KV, MY_DO; worker is its default export
```

so a cell can call `await worker.fetch(new Request("https://x/"), env)`.
If the project can't load (for example, wrangler isn't installed in it),
the first cell says why and the kernel falls back to plain workerd.
Miniflare listens on a loopback TCP port, so here the token is what keeps
other local processes out.

### celld

celld runs the same driver, with three differences from workerd that
shape `src/celld-target.ts`:

- **No `UnsafeEval`.** celld allows a plain global `eval`, so the driver
  uses that, and no experimental flag is needed.
- **One module.** celld takes a single module, so `bundleDriver` bundles
  the driver and, in a project, its `main` into `driver.mjs`, and the
  config sets `no_bundle: true`. celld doesn't need esbuild of its own.
- **TCP only.** celld listens on TCP. The host picks a free loopback port,
  and since the built-in WebSocket can't set headers, the token goes in
  the query string.

`CelldHost.start`:

1. Finds `celld`: `~/.local/bin/celld`, where celld's installer puts it,
   since a Jupyter server's `PATH` often lacks that directory, else
   `celld` on `PATH`.
2. Writes `driver.mjs` and a generated `wrangler.jsonc` into a private
   temporary directory or, in a project, into `.celld/cdp-kernel` beside
   the project's config. The generated config copies the project's
   compatibility settings and bindings (vars, KV, D1, R2, Durable Objects,
   Queues, Workflows, services, Worker Loaders) and adds the token and
   `META` as vars. It's written with mode 0600 because it holds the token.
3. Runs `celld dev <dir> --host 127.0.0.1 --port <port> --no-watch`.
4. Polls `http://127.0.0.1:<port>/?token=...` until the driver answers 426
   (it's up, and wants a WebSocket), then opens the session.

If celld reports "Address already in use", because another process took
the port between the check and celld binding it, the start is retried up
to three times. celld rejects `wrangler.toml`; a project that can't load
is reported in the first cell, and the driver runs without it.

`celld dev` runs its worker process in a separate process group and waits
for it to stop gracefully, which a busy cell never allows. So stopping
kills that process first, then `celld dev`. The generated files are
removed when celld exits, unless the kernel process itself is killed
first. A project's state stays in `.celld/cdp-kernel` for the next kernel.

## Interrupts

As on Bun, nothing can stop JavaScript that's running, so the host sends a
`ping` on the session:

- If the driver answers within 500 ms, the cell was only waiting. The host
  abandons the cell's request and the cell ends as interrupted. The
  session, its I/O objects and every global stay, and whatever the cell
  started keeps running.
- If not, the cell is busy. The host stops the runtime (`SIGKILL` for
  workerd, `dispose()` for Miniflare, the process tree for celld) and the
  next cell starts a new one without the earlier state. The cell's output
  says so.

See [Interrupts](integrations.md#interrupts) for a diagram.

## Limits that follow from the design

- **`prompt()` and `confirm()` return `null`.** A request can't block
  waiting for the frontend, so they behave as when the frontend has no
  stdin.
- **No file system.** `jupyter.image(path)` throws; pass the image's bytes
  instead.
- **Packages must bundle for Workers.** Anything with native code, or that
  needs Node APIs Workers lacks, won't load.
- **No debugger**, as on Bun.

[Known gaps](known-gaps.md) lists the rest, per runtime.
