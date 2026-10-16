# Architecture

The design in full, with the alternatives considered, is in the [feasibility study](https://cdp-kernel.org/study.html) (also [`life-after-deno-jupyter.html`](life-after-deno-jupyter.html) in this directory). The scripts behind its runtime findings are in [`probes/`](../probes/).

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
  See [Cells and module loading](#cells-and-module-loading).
- Port `Deno.jupyter` (`40_jupyter.js`) to `runtime/display.mjs`.

Node and Deno are driven over CDP as described above. Bun, workerd and
celld can't be, so each has its own channel. [Runtime integrations](integrations.md)
explains the host/target split and how each runtime is driven, with
diagrams.

## Cells and module loading

A cell is written as a TypeScript module, but CDP's `Runtime.evaluate` runs
scripts. Deno closes that gap in two places:

- Its REPL transpiles each cell with deno_ast (swc) and
  `var_decl_imports: true` (`cli/tools/repl/session.rs`,
  `evaluate_ts_expression`): one pass strips types and turns `import`
  declarations into `var` bindings over dynamic imports.
- Its module loader then resolves and compiles whatever the cell imports:
  relative files, import maps, `npm:`, `jsr:`.

Neither exists on Node, Bun or workerd, so the kernel does the same work in
three pieces.

### esbuild: TypeScript to JavaScript

`transformSync` strips types and compiles JSX in the cell's text
(`stripTypesMapped` in `src/transform.ts`). As in Deno, it tries the `tsx`
loader first and falls back to `ts` for `<T>x` assertions. A Deno project's
`compilerOptions` (JSX mode and import source, `experimentalDecorators`)
are mapped onto esbuild's options by `src/deno-config.ts`. The output keeps
`import` and `export` as written (`verbatimModuleSyntax`), and esbuild's
source map is what the debugger uses to map lines back to the cell
([Debugger](debugger.md)).

### acorn: module syntax to script syntax

A script can't contain `import` or `export`, so acorn parses esbuild's output
and `rewriteModuleSyntax` edits the text:

| Cell | Script |
|---|---|
| `import x, { y as z } from "m"` | `var __cdpk_m0 = await __cdpk.import("m"); var x = __cdpk_m0["default"], z = __cdpk_m0["y"];` |
| `import * as ns from "m"` | `var __cdpk_m0 = await __cdpk.import("m"); var ns = __cdpk_m0;` |
| `import "m"` | `await __cdpk.import("m");` |
| `import("m")` | `__cdpk.import("m")` |
| `import.meta.url` | `__cdpk.meta.url` |
| `export const a = 1` | `const a = 1` |

This is the same shape as Deno's `var_decl_imports` output, with one
difference: every import goes through `__cdpk.import`, a function that
`runtime/bootstrap.mjs` installs in the target. Code evaluated over the
inspector has no module referrer, so Node rejects a bare `import()` ("A
dynamic import callback was not specified"). In Deno, its loader supplies
the referrer. Calling `import()` from the bootstrap module gives every cell
import a referrer, and `import.meta` describes the notebook rather than the
bootstrap module.

Edits keep line numbers: a multi-line import rewritten to one line is padded
with the newlines it replaced (`applyEdits`), so the cell's lines still match
esbuild's source map (#18).

On Bun, workerd and celld, cells don't run through replMode, so acorn has a
second job there: `hoistForEval` declares each top-level name with `var` in
the surrounding script and runs the cell inside an async function, which
gives top-level `await` and lets later cells see earlier declarations.

### Resolution: where imports go

esbuild and acorn only rewrite the cell's text. Resolution happens when
`__cdpk.import` runs, and differs per target:

- **Node.** `runtime/node-hooks.mjs` registers a synchronous resolve hook
  (`module.registerHooks`). Imports whose parent is the bootstrap module are
  re-parented to the notebook's directory, so `./x.ts` and bare package names
  resolve as the user expects. `npm:name@range` installs on first use into
  `~/.cache/cdp-kernel/npm`, under an alias per request so two ranges of one
  package can coexist. `jsr:@scope/name` maps onto JSR's npm registry
  (`npm.jsr.io`) as `@jsr/scope__name`.
- **Bun.** Bun has no `registerHooks`, so `bootstrap.mjs` resolves `npm:` and
  `jsr:` itself with the same helpers, installing with `bun add`, and
  resolves everything else from the notebook's directory.
- **Deno.** Deno's own resolution applies (import maps, `npm:`, `jsr:`, its
  global cache). In a Deno project, a bare name Deno can't place is retried
  from the project's `node_modules` (`runtime/node-modules-resolve.mjs`).
  Only the cell transform comes from esbuild and acorn.
- **workerd and celld.** These can't load modules at runtime beyond their
  builtins, so the host bundles whatever a cell imports with esbuild's
  `build()` and sends the bundle with the cell (`src/workerd-target.ts`,
  `src/celld-target.ts`). In a Workers project, the project's `main` is
  bundled the same way (`src/workers-project.ts`).

### Imported TypeScript files

esbuild transforms only the cell. A `.ts` file the cell imports is loaded
by the target runtime itself:

- Node strips its types natively (strip-only mode). Syntax that needs
  code generation, such as `enum`, `namespace` with values, or parameter
  properties, is rejected with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, though
  the same syntax works in a cell.
- Bun and Deno transpile TypeScript fully.
- On workerd and celld, esbuild's bundle compiles it.

In Deno, the loader compiles every module the same way, so a cell and an
imported file accept the same syntax.

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
