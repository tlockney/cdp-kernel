# Runtimes

Node and Deno targets run cells over the Chrome DevTools Protocol. Bun, workerd and celld can't be driven that way, so each has its own backend that evaluates cells in-process. This page covers those three.

## Bun

Bun's `--inspect` speaks the WebKit Inspector Protocol, which lacks what the
CDP backend relies on: `replMode`, `Runtime.addBinding`,
`Runtime.terminateExecution`, and top-level `await` in `Runtime.evaluate`.
So the Bun target has its own backend (`src/bun-target.ts`,
`runtime/bun-channel.mjs`):

- **No inspector.** The host and Bun exchange JSON lines over a pipe on
  fd 3, which only the host holds, so there is no port to discover.
- **Cells run in-process.** Each cell becomes global code wrapped in an
  async function (`transformCellForEval` in `src/transform.ts`). Its
  top-level declarations become properties of `globalThis`, so later
  cells, and closures from this one, see them. This is the
  tslab/IJavascript technique.
- **Same output ordering.** stdout and stderr stay pipes, ordered against
  display messages by the same barrier markers as the CDP targets.
- **Interrupt.** A cell that's waiting on a promise is interrupted in place,
  keeping state. A busy one (`while (true) {}`) can't be reached, so Bun is
  stopped and restarts on the next cell without the earlier state. The cell
  output says so.

What differs from the CDP targets is listed under [Known gaps](known-gaps.md).

## workerd

workerd's inspector can evaluate code, but outside a request there is no
I/O context: timers, `fetch` and `crypto.randomUUID()` throw "Disallowed
operation called within global scope". So the workerd target runs its
cells inside a driver Worker (`src/workerd-target.ts`,
`runtime/workerd-worker.mjs`):

- **One session.** The host opens a single WebSocket to the driver, and
  every cell runs inside that session's request. Cells get Workers'
  `fetch`, `Request`, `caches`, timers and randomness, and anything one
  cell makes carries over to the next: globals, a Durable Object stub, a
  stream, a timer still pending.
- **A private socket.** Outside a Workers project, the host writes a
  workerd config into a private temporary directory and serves the driver
  on a Unix socket there, opened with a per-launch token. There is no TCP
  port and no inspector.
- **Cells.** Cells are transformed as for Bun and run by workerd's
  `UnsafeEval` binding (hence `--experimental`).
- **Output.** `console` output and display messages come back over the
  session as they happen, in order.
- **Interrupt.** A cell that's waiting on something is abandoned in place,
  keeping state, as on Bun. A busy one gets Bun's treatment too: workerd is
  stopped and restarts on the next cell.

What workerd's own process prints, such as its warnings, goes to the Jupyter
server log, not the notebook.

### Workers projects

If a `wrangler.jsonc`, `wrangler.json` or `wrangler.toml` sits in the
notebook's directory or above it, the driver runs on the project's own
Miniflare, the simulator `wrangler dev` uses, with the project's bindings
(`src/workers-project.ts`):

- `env` holds the bindings: whatever wrangler translates for Miniflare.
  Vars, KV, D1 and Durable Objects are tested; R2, Queues and the others
  go through the same path but aren't.
- The project's `main` is bundled into the driver, so its Durable Object
  classes run, and `worker` is its default export:
  `await worker.fetch(new Request("https://x/"), env)`.
- State lives in the project's `.wrangler/state/cdp-kernel`, beside
  `wrangler dev`'s own, so the two never open the same Durable Object.
- The first cell's output names the bindings. If the project can't load,
  for example because wrangler isn't installed in it, the first cell says
  why and the kernel runs on plain workerd.

wrangler and Miniflare come from the project's `node_modules`, so they match
its versions. Miniflare 4 and 5 both work. Miniflare listens on a loopback
TCP port, so there the per-launch token is what keeps other local processes
out.

## celld

[celld](https://github.com/denoland/celld) runs Workers and Durable Objects
on your own storage. Like workerd it has no I/O outside a request, so the
celld target runs the same driver Worker over the same WebSocket session
(`src/celld-target.ts`). Cells, output, interrupts and host-bundled imports
all work as on workerd. The differences:

- **No `UnsafeEval` needed.** celld allows a plain global `eval`, so it runs
  without workerd's `--experimental`.
- **One module.** The host bundles the driver, and a project's `main`, into
  a single module, and gives celld the result with `no_bundle`. celld
  doesn't need its own esbuild.
- **Loopback TCP.** celld listens only on TCP, so the session is a loopback
  WebSocket opened with a per-launch token. The kernel picks a free port
  and runs `celld dev --no-watch` on a generated config.
- **Projects.** In a celld project (a `wrangler.jsonc` or `wrangler.json`
  at or above the notebook), the generated config copies the project's
  compatibility settings and bindings: vars, KV, D1, R2, Durable Objects,
  Queues, Workflows, services, Worker Loaders. `env` and `worker` then work
  as on workerd. The generated config is written to the project's
  `.celld/cdp-kernel` and removed when the kernel stops. The state stays
  there across kernels, beside `celld dev`'s own `.celld/dev`. celld rejects `wrangler.toml`; a project
  that can't load is reported in the first cell, and the driver runs alone.
- **Stopping.** `celld dev` runs its node in a separate process group and
  waits for it to stop gracefully, which a busy cell never allows. So an
  interrupt of a busy cell kills the node, then `celld dev`.
