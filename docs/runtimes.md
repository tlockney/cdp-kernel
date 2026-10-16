# Choosing a runtime

cdp-kernel runs your cells in a separate **target** runtime, and each
target is its own Jupyter kernel. Install one per runtime you want
([Install](install.md)) and switch between them with **Kernel › Change
Kernel**. The same notebook usually runs unchanged on all of them; this
page covers what differs.

## At a glance

| Kernel | Runtime | Pick it for |
|---|---|---|
| `cdp-node` | Node | The default. Node's APIs and npm packages, the debugger. |
| `cdp-deno` | Deno | Deno's APIs, `Deno.jupyter`, notebooks written for `deno jupyter`, Deno projects. |
| `cdp-node-deno` | Node with a `Deno` namespace | Running a notebook written for Deno on Node. |
| `cdp-bun` | Bun | Bun's APIs and its fast package installs. |
| `cdp-workerd` | workerd | Trying Cloudflare Workers code and a Workers project's bindings. |
| `cdp-celld` | celld | Workers and Durable Objects on celld, with a project's bindings. |

| | Node, Deno | Bun | workerd, celld |
|---|---|---|---|
| [Debugger](debugger.md) | yes | no | no |
| `prompt()`, `confirm()` | yes | yes | no: return `null` / `false` |
| `jupyter.image(path)` | yes | yes | no file system: pass bytes |
| Interrupt a waiting cell | keeps state | keeps state | keeps state |
| Interrupt a busy cell (`while (true) {}`) | keeps state | restarts, state lost | restarts, state lost |
| Packages with native add-ons | yes | yes | no |
| `const` and global names | as in a module | `globalThis` properties | `globalThis` properties |

[Known gaps](known-gaps.md) has the full list of differences.

## Node and Deno

Node and Deno run cells the way `deno jupyter` does, so they behave the
most like an ordinary module: top-level `const` stays constant, any final
expression is the cell's result, and interrupt never loses state. They're
the only targets with JupyterLab's debugger.

On Deno, `Deno.jupyter` is available alongside `jupyter`, and a
`deno.json` at or above the notebook is used as `deno jupyter` uses it
([Deno projects](notebooks.md#deno-projects)). To run a Deno notebook on
Node instead, use `cdp-node-deno`; [Notebooks written for
Deno](jupyter-api.md#notebooks-written-for-deno) covers what it supports.

## Bun

Cells get Bun's globals (`Bun.file`, `Bun.serve`, …), and `npm:` imports
install with `bun add`. Two things behave differently from Node:

- Top-level declarations become properties of `globalThis`. A `const` can
  be reassigned by a later cell, and declaring a global's name
  (`const fetch = ...`) replaces that global. Only an expression statement
  at the very end of a cell is shown as its result.
- Interrupting a cell that's busy computing stops Bun. The next cell
  starts a fresh Bun without the earlier state, and the cell output says
  so. A cell that's waiting (on a timer, a fetch) is interrupted in place.

## workerd

Cells run inside a Worker, so they get Workers' `fetch`, `Request`,
`caches`, timers and `crypto`, and anything one cell creates carries over
to the next. There is no file system, and `prompt()` and `confirm()`
can't be answered. Imports are bundled before each cell runs, so packages
with native add-ons don't load. Declarations, results and interrupts
behave as on Bun.

Unlike production Workers, the cells share one request that never ends, so
there's no per-request CPU or duration limit and no `ctx.waitUntil`.
workerd's own warnings go to the Jupyter server log, not the notebook.

### Workers projects

If a `wrangler.jsonc`, `wrangler.json` or `wrangler.toml` sits in the
notebook's directory or above it, cells run on the project's own
Miniflare, the simulator `wrangler dev` uses:

- `env` holds the project's bindings. Vars, KV, D1 and Durable Objects
  are tested; R2, Queues and the others go through the same path but
  aren't.
- `worker` is the project's default export, with its Durable Object
  classes loaded:
  `await worker.fetch(new Request("https://x/"), env)`.
- The first cell's output names the bindings. If the project can't load,
  for example because wrangler isn't installed in it, the first cell says
  why and the kernel runs on plain workerd.
- State lives in `.wrangler/state/cdp-kernel`, beside `wrangler dev`'s
  own, so the two never open the same Durable Object.

wrangler and Miniflare come from the project's `node_modules`, so they
match its versions; Miniflare 4 and 5 both work. The project's `main` is
bundled with esbuild, not wrangler's build, so custom `build` commands,
`alias` and module `rules` aren't applied.

## celld

[celld](https://github.com/denoland/celld) runs Workers and Durable
Objects on your own storage. Cells behave as on workerd.

In a project (a `wrangler.jsonc` or `wrangler.json` at or above the
notebook; celld rejects `wrangler.toml`), the kernel copies the project's
compatibility settings and bindings: vars, KV, D1, R2, Durable Objects,
Queues, Workflows, services and Worker Loaders. `env` and `worker` then
work as on workerd. State stays in `.celld/cdp-kernel` across kernels,
beside `celld dev`'s own `.celld/dev`. `assets`, `triggers`, `containers`
and `.dev.vars` aren't copied.

## How they work

[Runtime integrations](integrations.md) explains how the kernel drives
each runtime, with diagrams: [Node and Deno](integration-cdp.md) over the
Chrome DevTools Protocol, [Bun](integration-bun.md) over a private pipe,
and [workerd and celld](integration-workers.md) through a driver Worker.
