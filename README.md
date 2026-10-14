# cdp-kernel

A Jupyter kernel extracted from Deno's (`deno jupyter`, v2.9.6) that drives
any V8 runtime over the Chrome DevTools Protocol. The kernel host runs on
Node; the code you type runs in a separate **target** runtime: Node or Deno
today, and anything else whose inspector speaks CDP in principle.

This is a spike. It passes a conformance suite derived from Deno's own
Jupyter integration tests on both targets. It isn't packaged, and it hasn't
been used for real work. The feasibility study behind it covers the design,
the other options considered (workerd, Bun, rusty_v8, FFI), and the
evidence: [`docs/life-after-deno-jupyter.html`](docs/life-after-deno-jupyter.html).
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

## Use

```sh
npm ci
node src/main.ts install --runtime node                 # kernelspec cdp-node
node src/main.ts install --runtime deno                 # kernelspec cdp-deno
node src/main.ts install --runtime node --deno-compat   # kernelspec cdp-node-deno
```

Then pick the kernel in JupyterLab or VS Code. The kernelspec points at this
checkout, so don't move it after installing. Requires Node 24+; Node 26 is
what's been tested.

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
  - On Deno they use Deno's global cache. The target runs with
    `--node-modules-dir=none --no-lock`, so a project-local `node_modules`
    isn't used.
- `prompt()` and `confirm()` work over the stdin channel. Interrupt keeps
  state.

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
npm test       # 112 unit tests (node:test)
npm run e2e    # conformance suite via jupyter_client/libzmq, on node, deno, node-deno
uv run --with nbclient --with nbformat python examples/run_notebook.py   # Deno-style notebook on deno + node-deno
```

The e2e suite follows Deno's `tests/integration/jupyter_tests.rs` and adds
the gaps those tests leave: display ordering, TS, imports, `npm:`/`jsr:`,
completion, and `update_display_data`. Set `CDPK_E2E_OFFLINE=1` to skip the
registry-dependent checks.

## Known gaps

- No comms, so no ipywidgets. Deno has none either.
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
- Targets:
  - **Bun** speaks the WebKit inspector protocol: no `replMode`, bindings,
    `terminateExecution`, or top-level await in `Runtime.evaluate`.
  - **workerd** forbids timers and I/O outside a request.

  Both need a different backend; see the writeup.

## Provenance

`src/zmtp.ts`, `src/wire.ts`, `src/kernel.ts`, `src/text.ts` and
`runtime/display.mjs` are ports of Deno's `cli/js/jupyter_kernel.js` and
`cli/js/40_jupyter.js` at v2.9.6 (commit `e518fbd`), Copyright 2018-2026 the
Deno authors, MIT license. Each file header says which parts.
