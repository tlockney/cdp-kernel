# Architecture

The design in full, with the alternatives considered, is in the [feasibility study](https://claude.ai/artifact/S66TnTmhCzPy2EW7jbeeue) (also [`life-after-deno-jupyter.html`](life-after-deno-jupyter.html) in this directory). The scripts behind its runtime findings are in [`probes/`](../probes/).

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

## How the tricky parts work

| Problem | Approach |
|---|---|
| Inspector-evaluated code has no module referrer, so Node rejects `import()` | Static imports are rewritten to `var x = (await __cdpk.import("m")).x` (Deno's `var_decl_imports`), and `import()` and `import.meta` go through the bootstrap module. A resolve hook re-parents those imports to the notebook directory. |
| A busy loop inside `Runtime.evaluate` blocks every inspector message, so interrupt is never seen | Each cell starts with `await __cdpk.tick()` (one macrotask), so user code runs as an ordinary task. `Runtime.terminateExecution` then arrives on a second CDP session. The host abandons the evaluate, whose promise never settles. |
| stdout/stderr arrive over pipes and display messages over the WebSocket, so they race | Every display message is preceded by a numbered marker on both pipes. The host releases the message only after both pipes reach the marker, and holds later pipe output until the message is out. |
| `prompt()` must be synchronous | The target sends an `input_request` through a CDP binding, then blocks on a `readSync` of stdin. The host writes the reply as one JSON line. |
| Uncaught errors from timers would kill the target | `uncaughtException` and `unhandledrejection` handlers report them to stderr. |

## Provenance

`src/zmtp.ts`, `src/wire.ts`, `src/kernel.ts`, `src/text.ts` and
`runtime/display.mjs` are ports of Deno's `cli/js/jupyter_kernel.js` and
`cli/js/40_jupyter.js` at v2.9.6 (commit `e518fbd`), Copyright 2018-2026 the
Deno authors, MIT license. Each file header says which parts.
