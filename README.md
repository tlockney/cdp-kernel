# cdp-kernel

A Jupyter kernel extracted from Deno's (`deno jupyter`, v2.9.6) that drives
any V8 runtime over the Chrome DevTools Protocol. The kernel host runs on
Node or Deno; the code you type runs in a separate **target** runtime:
Node or Deno over CDP. Bun and workerd evaluate cells in-process instead
(see [Bun](#bun) and [workerd](#workerd)). In principle, anything else
whose inspector speaks CDP works too.

This is early software. It passes a conformance suite derived from Deno's
own Jupyter integration tests on every target, and it's packaged for npm and
JSR as `@tlockney/cdp-kernel`, but it hasn't seen much real use yet. The
feasibility study behind it covers the design,
the other options considered (workerd, Bun, rusty_v8, FFI), and the
evidence: [read it online](https://claude.ai/artifact/S66TnTmhCzPy2EW7jbeeue)
(also in the repo as
[`docs/life-after-deno-jupyter.html`](docs/life-after-deno-jupyter.html)). It
was written before packaging, so it calls the project a spike.
The scripts that produced its runtime findings are in [`probes/`](probes/).

## Why this shape

Deno 2.9's kernel is already two halves joined by thirteen ops
(denoland/deno#34083 rewrote it in JS and dropped libzmq):

- `cli/js/jupyter_kernel.js`: ZMTP and the Jupyter wire protocol in plain
  JS over TCP.
- A REPL isolate driven by CDP calls: `Runtime.evaluate` with
  `replMode: true`, `callFunctionOn`, `getProperties`,
  `globalLexicalScopeNames`.

So the extraction is:

- Port the protocol half to `node:net` and `node:crypto`: `src/zmtp.ts`,
  `src/wire.ts`, `src/kernel.ts`.
- Point the CDP half at another runtime's `--inspect` WebSocket:
  `src/target.ts`, `src/cdp.ts`.
- Replace what Deno's module loader did with esbuild + acorn
  (`src/transform.ts`) and Node resolve hooks (`runtime/node-hooks.mjs`).
- Port `Deno.jupyter` (`40_jupyter.js`) to `runtime/display.mjs`.

## Install

Each install writes a Jupyter kernelspec: `cdp-node`, `cdp-deno`,
`cdp-node-deno` (Node with the Deno compatibility namespace), `cdp-bun`, or
`cdp-workerd`. Then pick the kernel in JupyterLab or VS Code.

**From npm** (host runs on Node 24+; Node 26 is what's been tested):

```sh
npm install -g @tlockney/cdp-kernel
cdp-kernel install --runtime node
cdp-kernel install --runtime deno
cdp-kernel install --runtime node --deno-compat
cdp-kernel install --runtime bun
cdp-kernel install --runtime workerd
```

The kernelspec records the absolute paths of `node` and the installed
package. Re-run `install` after upgrading either.

**From JSR** (host runs on Deno):

```sh
deno run -A jsr:@tlockney/cdp-kernel/cli install --runtime deno
```

The kernelspec pins the release it was installed from
(`jsr:@tlockney/cdp-kernel@<version>/cli`). On first launch the target's
runtime modules are copied into `~/.cache/cdp-kernel/runtime/`. A Node
target needs `node` on `PATH`, and a Bun target needs `bun` (1.4 is what's
been tested). A workerd target uses the `workerd` in the notebook
directory's `node_modules` (a Workers project has one through wrangler),
or the one on `PATH` (`npm install -g workerd`; 2026-10-15 is what's been
tested).

Deno 2.9+ refuses package versions less than 24 hours old by default
([minimum dependency age](https://docs.deno.com/go/minimum-dependency-age)).
In a release's first day, the install command fails with "blocked by the
minimum dependency age policy". Wait out the day, or install an earlier
release. Passing `--min-dep-age=0` gets the install through, but the
kernelspec doesn't carry the flag, so the kernel still won't launch until
the release is a day old.

**From a checkout**, for working on the kernel itself:

```sh
npm ci
npm run install:node        # kernelspec cdp-node
npm run install:deno        # kernelspec cdp-deno
npm run install:node-deno   # kernelspec cdp-node-deno
npm run install:bun         # kernelspec cdp-bun
npm run install:workerd     # kernelspec cdp-workerd
```

These kernelspecs point at the checkout, so don't move it after installing.

In a cell:

- `jupyter.display`, `jupyter.md`, `jupyter.html`, `jupyter.svg`,
  `jupyter.image`, `jupyter.format`, `jupyter.broadcast`, and
  `Symbol.for("Jupyter.display")`: the same API as `Deno.jupyter`.
- `Deno.jupyter` also works:
  - On a Deno target it is a proxy over the real namespace. Deno's own
    getter throws outside `deno jupyter`.
  - On Node it needs `--deno-compat`. That installs a `Deno` namespace for
    file, env and process APIs (`runtime/deno-compat.mjs`).
  - The shim is opt-in because libraries detect Deno with `typeof Deno`, and
    would take Deno code paths that call APIs it doesn't cover.
- Imports work: TypeScript, TSX, enums, top-level `await`, and `const`
  redeclaration across cells. Specifiers can be `./local.ts`, bare packages
  from the notebook's `node_modules`, `node:` builtins, and `npm:pkg@range`
  or `jsr:@scope/pkg@range`.
  - On Node, `npm:` and `jsr:` install on first use into
    `~/.cache/cdp-kernel/npm`.
  - On Deno they use Deno's global cache, unless the notebook is in a Deno
    project (below).
  - On Bun they install with `bun add` into `~/.cache/cdp-kernel/bun`. Other
    bare imports resolve from the notebook's directory, so without a
    `node_modules` there, Bun auto-installs them.
  - On workerd, the host bundles every import other than a builtin
    (`node:`, `cloudflare:`) with esbuild, using Workers' resolution
    conditions, and sends it with the cell. `npm:` and `jsr:` install into
    the npm cache first, as on Node.
- **Deno projects.** If a `deno.json` or `deno.jsonc` sits in the notebook's
  directory or above it, a Deno target uses it, as `deno jupyter` does:
  - its import map (`"@/": "./lib/"` aliases, mapped packages);
  - its `nodeModulesDir` setting, with `package.json` dependencies from the
    project's `node_modules`;
  - its JSX and decorator `compilerOptions`: `jsx` (`react-jsx`,
    `react-jsxdev`, `precompile`, `react`), `jsxImportSource`,
    `jsxFactory`, `jsxFragmentFactory`, `experimentalDecorators`.

  The import map wins over `node_modules`, as in Deno. The kernel never
  writes to the project's lockfile. A `deno.json` that doesn't parse is
  reported in the first cell's output, and the kernel runs as in a plain
  directory. Outside a project, the target runs with
  `--node-modules-dir=none --no-lock`.
- `prompt()` and `confirm()` work over the stdin channel, except on
  workerd. Interrupt keeps state, except for a busy cell on Bun or workerd
  (below).

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

What differs from the CDP targets is listed under [Known gaps](#known-gaps).

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

## Editor types

Cells run untyped, as in `deno jupyter`. Notebook code your editor
type-checks can declare the globals.

**Node notebooks.** The npm package ships the declarations. Add it as a dev
dependency, then reference it once from a cell or a `.d.ts` in the project:

```ts
/// <reference types="@tlockney/cdp-kernel/globals" />
await jupyter.display(jupyter.md`typed`);
const name: string | null = prompt("Name?", "", { password: false });
```

That declares `jupyter`, `prompt` and `confirm`. With the `cdp-node-deno`
kernel, use `@tlockney/cdp-kernel/globals/deno-compat` instead: it adds the
`Deno` namespace the compatibility shim implements. A custom display is a
class with a `[jupyter.$display]()` method returning a MIME bundle.
`jupyter.$display` is `Symbol.for("Jupyter.display")` at runtime, but only
`jupyter.$display` carries the precise type.

**Deno notebooks.** Use `Deno.jupyter`, which Deno already types and which a
Deno target provides. The JSR package doesn't ship these globals, because
JSR doesn't allow packages to augment global types.

## Widgets and comms

`deno jupyter` has no comms. Here they're supported in both directions, so
anywidget-style widgets work in frontends with the `anywidget` extension:
JupyterLab, Notebook 7 and VS Code. Install it with
`pip install anywidget`; that's the frontend half, no Python kernel needed.

```ts
const counter = jupyter.widget({
  esm: `export default {
    render({ model, el }) {
      const btn = document.createElement("button");
      const update = () => { btn.textContent = \`count is \${model.get("count")}\`; };
      btn.onclick = () => { model.set("count", model.get("count") + 1); model.save_changes(); };
      model.on("change:count", update);
      update();
      el.append(btn);
    },
  };`,
  state: { count: 0 },
});
counter.on("change:count", (value) => console.log("clicked to", value));
counter; // display it
```

The model API:

- `get(key)`, and `set(key, value)` or `set({ ... })`, which syncs to every
  view.
- `on("change:key" | "change" | "msg:custom", listener)` and `off(...)`.
- `send(content, buffers)` for custom messages.
- `close()`.

`Uint8Array`, `ArrayBuffer` and `DataView` values in the state travel as
binary buffers. JupyterLab restores widget state after a page reload over
the `jupyter.widget.control` comm.

The comm layer underneath is available directly, for other comm-based
protocols:

```ts
const comm = jupyter.comm.open("my.target", { hello: 1 });
comm.onMsg(({ data, buffers }) => console.log(data, buffers.length));
comm.send({ ping: true });
jupyter.comm.registerTarget("echo", (comm) => comm.onMsg((m) => comm.send(m.data)));
```

Comm handlers run like cells. Their output goes to the notebook as replies
to the message that triggered them, an exception is shown on stderr, and
interrupt stops a stuck handler. Messages are processed one at a time with
cell executions, as in ipykernel, so a widget event that arrives during a
long cell waits for the cell to finish.

## How the tricky parts work

| Problem | Approach |
|---|---|
| Inspector-evaluated code has no module referrer, so Node rejects `import()` | Static imports are rewritten to `var x = (await __cdpk.import("m")).x` (Deno's `var_decl_imports`), and `import()` and `import.meta` go through the bootstrap module. A resolve hook re-parents those imports to the notebook directory. |
| A busy loop inside `Runtime.evaluate` blocks every inspector message, so interrupt is never seen | Each cell starts with `await __cdpk.tick()` (one macrotask), so user code runs as an ordinary task. `Runtime.terminateExecution` then arrives on a second CDP session. The host abandons the evaluate, whose promise never settles. |
| stdout/stderr arrive over pipes and display messages over the WebSocket, so they race | Every display message is preceded by a numbered marker on both pipes. The host releases the message only after both pipes reach the marker, and holds later pipe output until the message is out. |
| `prompt()` must be synchronous | The target sends an `input_request` through a CDP binding, then blocks on a `readSync` of stdin. The host writes the reply as one JSON line. |
| Uncaught errors from timers would kill the target | `uncaughtException` and `unhandledrejection` handlers report them to stderr. |

## Tests

```sh
npm run check  # tsc --strict over src/ and test/
npm test       # unit tests (node:test)
npm run e2e    # conformance suite via jupyter_client/libzmq, on every target variant
npm run test:lab   # an anywidget counter in real JupyterLab, headless Chromium (node, deno, bun, workerd)
uv run --with nbclient --with nbformat python examples/run_notebook.py   # Deno-style notebook on deno + node-deno
```

The e2e suite follows Deno's `tests/integration/jupyter_tests.rs` and adds
the gaps those tests leave: display ordering, TS, imports, `npm:`/`jsr:`,
completion, and `update_display_data`. Set `CDPK_E2E_OFFLINE=1` to skip the
registry-dependent checks. Set `CDPK_E2E_CLI` to run it through a different
CLI: an installed npm bin, or `deno run -A src/main.ts` to test a Deno host.

## Releasing

One version number lives in three places: `package.json`, `deno.jsonc` and
`src/package.ts`. `test/package.test.ts` fails if they disagree. To release:

1. Bump all three, commit, and merge to `main`.
2. Tag and push: `git tag v0.1.1 && git push origin v0.1.1`.

The `publish` workflow then:

1. Checks that the tag matches the version.
2. Runs the type check, the unit tests, and the e2e suite against the packed
   npm tarball and against a Deno host.
3. Publishes to JSR (`deno publish`).
4. Publishes to npm (`npm publish`).

Both registries authenticate the workflow through GitHub OIDC, so no tokens
are stored:
- **npm:** a trusted publisher for `tlockney/cdp-kernel` + `publish.yml`.
- **JSR:** the package is linked to this repo in its JSR settings.

Neither registry lets a version be republished. Each job skips a version
its registry already has, so re-running a release only fills in the half
that failed.

## Known gaps

- Widgets are anywidget-style (`jupyter.widget`). The classic ipywidgets
  controls (sliders, dropdowns) are Python classes, so they're not available.
- No `inspect_request` content and no history. Deno has neither.
- No debugger.
- `npm:` on Node:
  - one npm alias per `name@range`;
  - no lockfile;
  - peer dependencies resolve by real name from the shared cache.
- No type checking. Deno doesn't type-check REPL cells either.
- Results are formatted with `util.inspect` on Node, so they look slightly
  different from Deno's `Deno.inspect`.
- WebGPU texture and buffer display is dropped.
- On Bun:
  - Interrupting a busy cell restarts Bun and loses state. An awaiting cell
    keeps it.
  - Top-level declarations are properties of `globalThis`. A `const` can be
    reassigned, and declaring a global's name (`const fetch = ...`) replaces
    that global rather than shadowing it.
  - Only a trailing expression statement shows a result: `x` does, but
    `if (c) { x }` doesn't.
  - Bun 1.4 can't import a module whose path contains `?`.
  - No `--deno-compat` namespace.
- On workerd:
  - All cells share one request, so it never ends. Unlike production
    Workers, there is no per-request CPU or duration limit, and
    `ctx.waitUntil` isn't available in a cell.
  - No `prompt()` or `confirm()` answers: they return `null`, as without a
    stdin channel. `jupyter.image(path)` can't read files; pass the bytes.
  - Each imported module is bundled with its dependencies. Two imports that
    share a dependency each get their own copy.
  - Interrupting a busy cell restarts workerd and loses state.
  - Top-level declarations and results behave as on Bun: declarations are
    `globalThis` properties, and only a trailing expression shows a result.
  - In a Workers project, `main` is bundled with esbuild directly, not with
    wrangler's build. Custom `build` commands, `alias` and module `rules`
    aren't applied.

## Provenance

`src/zmtp.ts`, `src/wire.ts`, `src/kernel.ts`, `src/text.ts` and
`runtime/display.mjs` are ports of Deno's `cli/js/jupyter_kernel.js` and
`cli/js/40_jupyter.js` at v2.9.6 (commit `e518fbd`), Copyright 2018-2026 the
Deno authors, MIT license. Each file header says which parts.
