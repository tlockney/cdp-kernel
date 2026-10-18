# Changelog

What changed in each release of `@tlockney/cdp-kernel` (npm and JSR).
Issue and pull request numbers refer to
[tlockney/cdp-kernel](https://github.com/tlockney/cdp-kernel).

## Unreleased

- With the debugger's "caught exceptions" filter on, a debug console
  expression that throws (a typo is enough) no longer pauses the target in
  the kernel's own call. On Node the request hung until Continue; on Deno
  the pause ended by itself and the runtime then ran no timers or
  immediates, so every later cell hung. The kernel's own inspector calls
  (debug console, rich variable view, Shift-Tab, error descriptions) now
  run with exception pauses held off
  ([#307](https://github.com/tlockney/cdp-kernel/issues/307)).

- Notebook output on the docs site reads in dark mode: the MoMA example's
  wall labels set their own text color, SVG charts sit on a light panel,
  and the scrubber widget's year labels follow the page's text color
  ([#312](https://github.com/tlockney/cdp-kernel/issues/312)).

## 0.6.0 (2026-10-18)

- Experimental: the kernel runs in a web page, with cells in a Web Worker
  and `npm:` imports from esm.sh. `scripts/build-browser.mjs` bundles it;
  [The browser](https://cdp-kernel.org/docs/integration-browser) says what
  works. The kernel's message handling moved to `src/kernel-core.ts`,
  which has no Node imports; the kernel process is unchanged.
- Node and Deno targets no longer keep the data of every comm message from
  the frontend, so dragging a widget's slider for a while doesn't grow the
  runtime. V8 kept each message as compiled source; messages now reach the
  target over its stdin
  ([#287](https://github.com/tlockney/cdp-kernel/issues/287)).
- Node and Deno targets no longer keep every cell's result and thrown
  error in memory. The inspector held each one it returned until released,
  so a session that showed large values (arrays, images) grew without
  bound; the kernel now releases them once the cell's output is shown
  ([#286](https://github.com/tlockney/cdp-kernel/issues/286)).
- The kernel starts its runtime only after it has bound all five ports
  from the connection file. A Deno runtime binds its inspector to a random
  port within milliseconds of starting and could take one of them, so the
  kernel died at startup with `EADDRINUSE`
  ([#257](https://github.com/tlockney/cdp-kernel/issues/257)).
- Deno's "Debugger session started." notice no longer shows up in the
  first cell's output when it arrives late
  ([#281](https://github.com/tlockney/cdp-kernel/issues/281)).
- Cells on Node and Deno that show output (a result, `display()`,
  `console.log`) no longer wait ~40 ms for the inspector socket: a trivial
  cell takes 7 ms instead of 48 ms on Node. Messages from the target now
  travel on its stdout, and the session that runs cells receives no
  inspector events
  ([#271](https://github.com/tlockney/cdp-kernel/issues/271)).
- A Node or Deno runtime could stop running `setTimeout` callbacks for
  good, leaving the kernel waiting on a cell or comm message forever. A
  kernel request that arrived while the runtime's own timer code ran
  could make the runtime lose its 1 ms timer list. Cells and comm
  handlers now yield with `setImmediate` instead
  ([#237](https://github.com/tlockney/cdp-kernel/issues/237)).
- Completion knows declared types: TypeScript's language service runs over
  the executed cells plus the one being edited, so `x.` lists a typed
  value's members even before it has a value, completion works inside
  expressions (`[1, 2].map((n) => n.toF`), and `npm:`/`jsr:` imports
  complete from their declarations. Runtime-only names are still listed
  after the typed ones, and JupyterLab shows each match's kind. The service
  runs in a worker thread started on the first completion (that first
  request is answered from the runtime alone) and ended after 10 minutes
  without one; it takes about 150 MB while running. Node targets get
  `@types/node` from the notebook's project, or installed once into the
  per-user npm cache. `--no-language-service` turns it off. `typescript` is
  now a dependency
  ([#273](https://github.com/tlockney/cdp-kernel/issues/273)).
- Shift-Tab inspection shows the declared type, signature and JSDoc from
  the same language service, then the runtime's value preview and
  properties. It also works on names that have no value yet and on members
  of expressions the runtime can't evaluate
  ([#274](https://github.com/tlockney/cdp-kernel/issues/274)).
- Typed completion and inspection know each target's globals: `deno types`
  on Deno, `@types/bun` on Bun, and on workerd and celld a Workers
  project's `worker-configuration.d.ts` (from `wrangler types`), else
  `@cloudflare/workers-types`. On Deno, imports an executed cell made
  (`npm:`, `jsr:`, URLs, the project's import map) are typed from Deno's
  own cache, found with `deno info`; nothing new is fetched for completion.
  On Bun, `npm:`/`jsr:` types come from Bun's install cache
  ([#275](https://github.com/tlockney/cdp-kernel/issues/275)).
- The docs describe typed completion and inspection, where types come
  from, their cost and limits, and `--no-language-service`
  ([#276](https://github.com/tlockney/cdp-kernel/issues/276)).
- Node 22.18+ is supported as the host and as a target; `engines` was
  `>=24`. 22.18 is the first Node 22 that strips TypeScript types without
  a flag, which imported `.ts` files rely on. CI adds Node 22 on Linux and
  macOS. The one difference found: Node 22 formats symbol keys as
  `{ [Symbol(k)]: 1 }`
  ([#264](https://github.com/tlockney/cdp-kernel/issues/264)).
- `kernel_info_request` on shell is answered without waiting for the
  runtime to start, so clients probing during a slow start get one reply
  instead of queuing more. Until the runtime is up, the banner leaves out
  its versions. `interrupt_reply` now waits at most 1 s for the runtime,
  under the 5 s clients allow control requests
  ([#253](https://github.com/tlockney/cdp-kernel/issues/253)).
- The kernel exits, stopping its runtime, when the server named by
  `JPY_PARENT_PID` exits, as ipykernel does, so a server that is killed or
  crashes no longer leaves kernels running. Without the variable (a kernel
  started by hand) nothing changes; on Windows it is ignored
  ([#254](https://github.com/tlockney/cdp-kernel/issues/254)).
- `cdp-kernel list` and `cdp-kernel uninstall [NAME...] [--all]` list and
  remove the kernelspecs cdp-kernel installed, without Jupyter. They use
  the same kernels directory as `install` and leave other kernels'
  kernelspecs alone
  ([#249](https://github.com/tlockney/cdp-kernel/issues/249)).
- `--type-strip sucrase` strips cells' types with sucrase, plain JavaScript,
  instead of esbuild's native binary, and an embedder can pass its own type
  stripper. sucrase is an optional dependency, loaded only when picked; it
  rejects decorators, `accessor` fields and namespaces
  ([#234](https://github.com/tlockney/cdp-kernel/issues/234),
  [#238](https://github.com/tlockney/cdp-kernel/issues/238)).
- A kernel that is SIGKILLed no longer leaves runtimes behind: a helper
  process started with the kernel kills the runtimes it registered, and
  removes their temp directories, when the kernel dies. This covers celld
  and a Node or Deno runtime busy in a cell ([#240](https://github.com/tlockney/cdp-kernel/issues/240)), and Miniflare's
  workerd ([#241](https://github.com/tlockney/cdp-kernel/issues/241)).
- When the kernel can't bind a connection-file port, it writes what holds
  the port (sockets and their processes, from `/proc` on Linux) to stderr
  ([#257](https://github.com/tlockney/cdp-kernel/issues/257)).
- The debugger moves a breakpoint off a line the type stripper blanked to
  the next line that runs ([#239](https://github.com/tlockney/cdp-kernel/issues/239)), and esbuild is loaded only when a
  cell needs it ([#238](https://github.com/tlockney/cdp-kernel/issues/238)).
- A container image with JupyterLab and every runtime
  ([#267](https://github.com/tlockney/cdp-kernel/issues/267)), published to `ghcr.io/tlockney/cdp-kernel` with each release
  ([#269](https://github.com/tlockney/cdp-kernel/issues/269)), a devcontainer built from it ([#268](https://github.com/tlockney/cdp-kernel/issues/268)), and Binder and
  Codespaces links ([#270](https://github.com/tlockney/cdp-kernel/issues/270)).
- Docs: Ganymede as a way to run notebooks without Python ([#250](https://github.com/tlockney/cdp-kernel/issues/250)), what
  VS Code needs to draw widgets ([#228](https://github.com/tlockney/cdp-kernel/issues/228)), the support policy and 1.0
  checklist ([#261](https://github.com/tlockney/cdp-kernel/issues/261)), and `CONTRIBUTING.md`, `SECURITY.md` and issue
  templates ([#262](https://github.com/tlockney/cdp-kernel/issues/262)).
- CI runs the tests nightly against the latest runtime releases
  ([#259](https://github.com/tlockney/cdp-kernel/issues/259)), adds a soak test of one long session per runtime ([#260](https://github.com/tlockney/cdp-kernel/issues/260)),
  and benchmarks startup and per-cell latency ([#265](https://github.com/tlockney/cdp-kernel/issues/265)). Releases can be
  cut from the Actions tab with the `release` workflow ([#235](https://github.com/tlockney/cdp-kernel/issues/235)).

## 0.5.0 (2026-10-16)

Changes in behavior:

- The npm and Bun package caches follow `XDG_CACHE_HOME`, as the runtime
  cache already did. With it set, packages are downloaded again into the
  new location, and `~/.cache/cdp-kernel/{npm,bun}` can be deleted
  ([#163](https://github.com/tlockney/cdp-kernel/issues/163)).
- On Bun, `console` output is formatted as on Node, and stdout and stderr
  writes are synchronous, so a large write before `prompt()` no longer
  deadlocks ([#180](https://github.com/tlockney/cdp-kernel/issues/180)).
- `stop_on_error` is honoured: execute requests queued behind a failed cell
  are aborted instead of run
  ([#123](https://github.com/tlockney/cdp-kernel/issues/123)).
- `process.exit()` or `Deno.exit()` in a cell ends the runtime, and the
  next cell starts a fresh one
  ([#130](https://github.com/tlockney/cdp-kernel/issues/130)).

New:

- On Node, `.ts`, `.tsx` and `.jsx` files imported by a cell are compiled
  with esbuild when Node's type stripping can't handle them (enums,
  namespaces, parameter properties, JSX)
  ([#73](https://github.com/tlockney/cdp-kernel/issues/73),
  [#91](https://github.com/tlockney/cdp-kernel/issues/91)).
- Cells can use standard decorators and `accessor` fields
  ([#142](https://github.com/tlockney/cdp-kernel/issues/142)), anonymous
  `export default class/function` and `import x = require()`
  ([#143](https://github.com/tlockney/cdp-kernel/issues/143)).
- `--deno-compat` throws a clear error for a `Deno` member it doesn't
  implement ([#172](https://github.com/tlockney/cdp-kernel/issues/172)).
- Documentation site at [cdp-kernel.org/docs](https://cdp-kernel.org/docs/),
  with getting started, runtime, troubleshooting, security, VS Code and
  CLI reference pages, and this changelog.

Jupyter protocol:

- Interrupting a cell blocked in `prompt()` makes `prompt()` throw instead
  of wedging the kernel, and a stale `input_reply` no longer answers the
  next prompt ([#121](https://github.com/tlockney/cdp-kernel/issues/121)).
- Malformed JSON from a cell or the stdin port no longer crashes the
  kernel ([#122](https://github.com/tlockney/cdp-kernel/issues/122)); a
  shell handler that throws replies with an error
  ([#125](https://github.com/tlockney/cdp-kernel/issues/125)).
- A silent request publishes no `execute_input`, a shell
  `shutdown_request` is handled, and control requests publish busy/idle
  ([#124](https://github.com/tlockney/cdp-kernel/issues/124)).
- A frontend-opened comm whose `comm_open` handler throws is dropped
  ([#137](https://github.com/tlockney/cdp-kernel/issues/137)).

Fixes:

- Runtimes no longer outlive the kernel: they are killed when it exits by
  SIGTERM, SIGHUP, an uncaught error or shutdown during startup
  ([#127](https://github.com/tlockney/cdp-kernel/issues/127),
  [#218](https://github.com/tlockney/cdp-kernel/issues/218)); Node and Deno
  targets exit when their kernel is SIGKILLed
  ([#219](https://github.com/tlockney/cdp-kernel/issues/219)); workerd
  processes and directories left by a dead kernel are cleaned up
  ([#220](https://github.com/tlockney/cdp-kernel/issues/220)); workerd is
  SIGKILLed when SIGTERM doesn't stop it
  ([#128](https://github.com/tlockney/cdp-kernel/issues/128)).
- Deadlocks: `prompt()` after a large write on Node
  ([#131](https://github.com/tlockney/cdp-kernel/issues/131)), a display
  payload `JSON.stringify` rejects
  ([#129](https://github.com/tlockney/cdp-kernel/issues/129)), and requests
  on a closed session ([#133](https://github.com/tlockney/cdp-kernel/issues/133)).
  An interrupt during result formatting reports `Interrupted`
  ([#135](https://github.com/tlockney/cdp-kernel/issues/135)).
- Fewer startup failures: a runtime whose start fails or stalls is stopped
  ([#52](https://github.com/tlockney/cdp-kernel/issues/52)); intermittent
  "Promise was collected" errors are fixed
  ([#50](https://github.com/tlockney/cdp-kernel/issues/50),
  [#55](https://github.com/tlockney/cdp-kernel/issues/55)); celld retries a
  start that loses a port race; a kernel port briefly in use at startup is
  retried ([#160](https://github.com/tlockney/cdp-kernel/issues/160)); a
  start whose bootstrap never installs fails with an error
  ([#134](https://github.com/tlockney/cdp-kernel/issues/134)).
- Cell results: a trailing sequence expression returns its last value on
  Bun, workerd and celld
  ([#140](https://github.com/tlockney/cdp-kernel/issues/140)); a trailing
  side-effect or type-only import is not the result
  ([#139](https://github.com/tlockney/cdp-kernel/issues/139)); stack-trace
  line numbers no longer shift
  ([#150](https://github.com/tlockney/cdp-kernel/issues/150)); the
  completeness check handles escaped backticks and regex literals
  ([#126](https://github.com/tlockney/cdp-kernel/issues/126)); `.ts`/`.tsx`
  imports with a query or fragment are compiled
  ([#145](https://github.com/tlockney/cdp-kernel/issues/145)).
- workerd and celld: a module that threw while loading is re-sent
  ([#147](https://github.com/tlockney/cdp-kernel/issues/147)); errors from
  timers and rejections after a cell are reported
  ([#148](https://github.com/tlockney/cdp-kernel/issues/148)); `npm:`/`jsr:`
  installs no longer block heartbeat and interrupt
  ([#149](https://github.com/tlockney/cdp-kernel/issues/149)).
- Deno target: `Deno.` completes and Shift+Tab inspects `Deno.*` again
  ([#132](https://github.com/tlockney/cdp-kernel/issues/132)).
- `cdp-kernel.lock.json` is written atomically, a live install lock is no
  longer stolen, and a corrupt lockfile names its path
  ([#144](https://github.com/tlockney/cdp-kernel/issues/144)).
- Runtime stderr notices are filtered per line, so user lines starting
  with "Download" are kept
  ([#136](https://github.com/tlockney/cdp-kernel/issues/136)); WebSocket
  fragmented binary messages and Close frames are handled
  ([#138](https://github.com/tlockney/cdp-kernel/issues/138)); cleanup of
  buffers, debugger files, token comparison and image errors
  ([#152](https://github.com/tlockney/cdp-kernel/issues/152)).
- npm installs run through `cmd.exe` on Windows
  ([#51](https://github.com/tlockney/cdp-kernel/issues/51)). Windows is
  still not supported.
- LICENSE credits the MurmurHash2 port's JupyterLab and Gary Court
  licenses ([#154](https://github.com/tlockney/cdp-kernel/issues/154)).
- CI tests Deno 2.x (latest) only, pins Bun 1.4, and smoke-tests the
  published JSR package after each release
  ([#146](https://github.com/tlockney/cdp-kernel/issues/146)).

## 0.4.0 (2026-10-15)

- JupyterLab's visual debugger on Node and Deno: breakpoints, stepping,
  variables and pause on exceptions, over CDP
  ([#18](https://github.com/tlockney/cdp-kernel/issues/18)).
- Inspection tooltips (Shift+Tab) and input history
  ([#10](https://github.com/tlockney/cdp-kernel/issues/10)).
- An opt-in `cdp-kernel.lock.json` pins `npm:`/`jsr:` versions per
  notebook, and installs are serialized
  ([#14](https://github.com/tlockney/cdp-kernel/issues/14)).
- `npm:` installs save exact versions, so a range stays at what it first
  resolved to, and `jsr:` works with npm 12
  ([#39](https://github.com/tlockney/cdp-kernel/issues/39),
  [#40](https://github.com/tlockney/cdp-kernel/issues/40)). Caches written
  by 0.3.0 or earlier can be deleted to start fresh.
- JSR kernelspecs start on release day despite Deno's minimum dependency
  age ([#12](https://github.com/tlockney/cdp-kernel/issues/12)).
- CI covers Node 24 and 26 with Deno 2.9 and the latest 2.x, on Linux and
  macOS ([#15](https://github.com/tlockney/cdp-kernel/issues/15)).
- A MoMA collection example notebook.

## 0.3.0 (2026-10-14)

- New targets: Bun ([#7](https://github.com/tlockney/cdp-kernel/issues/7)),
  workerd ([#8](https://github.com/tlockney/cdp-kernel/issues/8)) and celld
  ([#25](https://github.com/tlockney/cdp-kernel/issues/25)).
- In a Workers project, cells get the project's bindings as `env`
  ([#26](https://github.com/tlockney/cdp-kernel/issues/26)).

## 0.2.0 (2026-10-14)

- Jupyter comms and anywidget-style widgets with `jupyter.widget`
  ([#9](https://github.com/tlockney/cdp-kernel/issues/9)).
- Deno targets honour the notebook's Deno project config
  ([#13](https://github.com/tlockney/cdp-kernel/issues/13)).
- Type declarations for the `jupyter` global
  ([#11](https://github.com/tlockney/cdp-kernel/issues/11)).
- `kernel_info` reports the real version, and the inspector's URL is kept
  private ([#22](https://github.com/tlockney/cdp-kernel/issues/22)).

## 0.1.1 (2026-10-14)

First release on npm and JSR. A Jupyter kernel ported from `deno jupyter`
(v2.9.6) that runs cells on Node or Deno over the Chrome DevTools Protocol:
the `jupyter` display API, TypeScript, `npm:` and `jsr:` imports,
interrupt, `prompt()`/`confirm()`, and an opt-in `Deno` namespace for Node.
