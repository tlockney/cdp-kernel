# Feasibility study: life after deno jupyter

Deno's kernel is two halves joined by thirteen ops, and both halves come
apart cleanly. Re-joined over the DevTools Protocol, **the same kernel now
runs notebooks on Node and on Deno**, and on Bun, workerd and celld through
backends of their own.

This is the design document the project started from. It was written while
cdp-kernel was a spike and revised as the project shipped. The
[last section](#where-it-landed) compares what it predicted with what was
built. For how the kernel works today, read [Architecture](architecture.md)
and [Runtime integrations](integrations.md); for current limits, read
[Known gaps](known-gaps.md).

<dl class="study-meta">
  <div><dt>Subject</dt><dd>Deno's Jupyter kernel, once Deno is maintenance-only</dd></div>
  <div><dt>Targets weighed</dt><dd>Node, Deno, workerd, Bun, rusty_v8, FFI</dd></div>
  <div><dt>Evidence</dt><dd>Released as 0.4.0; 275/275 e2e checks across five runtimes; 322 unit tests; CI on Linux and macOS</dd></div>
  <div><dt>Sources</dt><dd><code>deno jupyter</code> v2.9.6 (commit <code>e518fbd</code>); live probes of Node 26.8.1, Deno 2.9.6, workerd 2026-09-30, Bun 1.4.0</dd></div>
  <div><dt>Compiled</dt><dd>2026-10-14, revised 2026-10-15 and 2026-10-16</dd></div>
  <div class="study-verdict"><dt>Verdict</dt><dd>Extract the JS halves; drive any runtime over CDP</dd></div>
</dl>

## Bottom line

::: info Revised 2026-10-16
Deno has since said the runtime stays on a 2.9.x LTS line until October
2027 ([What changed](#what-changed)), and the weakly held promise issue
found after release is fixed. Both, and the current test counts, are
folded in below. Each section links to the docs page that now covers its
topic in more depth.
:::

::: details Revision of 2026-10-15
The study was first compiled on 2026-10-14, when cdp-kernel was a spike.
It has since been released (`@tlockney/cdp-kernel` 0.4.0 on npm and JSR),
and most of the [next steps](#recommended-next-steps) are done. The verdict
held. The sections on the extraction, evidence, options, risks and next
steps are updated to the project's state at that date, and
[Where it landed](#where-it-landed) compares what the study predicted with
what was built. The analysis of what changed, the kernel's anatomy,
workerd, Bun and rusty_v8 is unchanged except where marked.
:::

**Extraction is not only possible; it is done, and released.** In June 2026
Deno rewrote its kernel (denoland/deno#34083). The Jupyter wire protocol,
ZeroMQ included, is now about 600 lines of plain JavaScript. Execution
happens in a separate isolate driven by standard
[Chrome DevTools Protocol](#glossary) calls. Node, Deno and workerd all
expose CDP through `--inspect`, so the kernel can be pulled apart and
pointed at a different runtime.

`cdp-kernel` does that. It is a port of Deno's protocol half, hosted on Node
or Deno, plus the `Deno.jupyter` display API and a replacement for the parts
of Deno's module loader that notebooks lean on: TypeScript, `npm:` and
`jsr:`. It passes a conformance suite derived from Deno's own Jupyter tests
on **Node 24 and 26** and **Deno 2.9 and the latest 2.x**, on Linux and
macOS. A notebook written for `deno jupyter`, with Polars DataFrames,
Vega-Lite, SVG and in-place display updates, gives the same outputs on both.

The other routes rank below it:

- **workerd** works only with a hybrid design. Timers and I/O are forbidden
  outside a request. *Built:* cells run inside one long-lived request
  ([workerd as a target](#workerd-as-a-target)).
- **Bun** needs its own backend, because it speaks WebKit's protocol rather
  than CDP. *Built:* an in-process evaluator over a pipe ([Bun](#bun)).
- **rusty_v8 or FFI** buys nothing for an evaluator. FFI cannot reach the
  host's V8 isolate, and a rusty_v8 host means rebuilding most of
  deno_core.

Recommendation: package `cdp-kernel` as a standalone, runtime-neutral
kernel. Treat CDP as the primary backend. Add backends for Bun and workerd
only if you need them.

*Outcome:* all three were done. The Bun and workerd backends, and a third
for celld that reuses the workerd driver, share the host, wire protocol,
transformer and display module, as predicted. The CDP targets remain the
most faithful; the in-process backends trade some REPL semantics and lose
state on a busy-cell interrupt ([Risks and gaps](#risks-and-gaps)).

## What changed

Ryan Dahl's post of 2026-10-09 ([deno.com/blog/cloudflare](https://deno.com/blog/cloudflare))
moves the Deno team to Cloudflare.

- **The runtime** gets about a year of monthly bug-fix and security
  releases, then development ends. *Revised below:* that year is a 2.9.x
  LTS line, running until October 2027.
- **Deploy** shuts down in six months.
- **JSR** stays up, with its infrastructure moving to Cloudflare.
- **rusty_v8** is the one piece with a stated future: "We will continue
  supporting rusty_v8 and work toward integrating it into workerd." No
  timeline is given.

The joint Cloudflare post, by Dahl and Kenton Varda, frames the goal as
making self-hosted workerd a first-class way to run Workers apps, with celld
folded back in. Neither post mentions deno_core, notebooks, or Jupyter.

*Revised:* celld is usable now. cdp-kernel gained a celld target on celld
0.6.2, alongside workerd.

*Revised 2026-10-16:* the Deno team's [state of Deno](https://github.com/denoland/deno/issues/37030)
(denoland/deno#37030, 2026-10-15) makes the year concrete:

- a 2.9.x LTS release every month, with bug fixes and security updates,
  until October 2027;
- no new features: feature pull requests are closed, and canary-only
  features are reverted so `main` matches 2.9;
- well-written bug-fix pull requests are still reviewed and merged.

It doesn't mention `deno jupyter`. For cdp-kernel this settles what the
Deno target is: a fixed target. Deno 2.9's kernel, module loader and
`Deno.*` APIs won't change under it, and the CI matrix's "Deno 2.9" and
"latest 2.x" should in practice test the same line. After October 2027 the Deno target is
only as alive as whichever fork carries the runtime on.

On the community side, denoland/deno#36995 collects fork announcements:
*rjs*, *dodo*, and one maintainer's planned conservative fork. Nobody has
claimed the Jupyter kernel. The existing Node kernels are stale: tslab last
released in mid-2024, IJavascript in 2021, and both depend on the native
`zeromq` addon.

::: details Sourcing
The announcement terms come from the Deno post, which was read directly.
The fork names, the Cloudflare post's wording, and the kernel release dates
come from a research sweep and were not re-checked, so treat them as
reported, not verified.
:::

## Anatomy of `deno jupyter` in 2.9

Older write-ups describe a Rust kernel built on libzmq or the runtimed
crates. That kernel is gone. PR #34083, "rewrite kernel in JS, drop
zeromq/runtimelib deps" (merged 2026-06-01), left two isolates in one
process:

- **Kernel isolate, `cli/js/jupyter_kernel.js`.** It implements
  [ZMTP](#glossary) 3.0 over `Deno.listen` TCP: the greeting, the READY
  command, and framing. On top of that sit the five Jupyter channels and
  HMAC signing via WebCrypto.
- **REPL isolate, `cli/tools/repl/session.rs`.** Each cell is parsed as TSX
  by swc and transpiled with `var_decl_imports`, which turns static imports
  into awaited dynamic imports. It then runs through `Runtime.evaluate` with
  [replMode](#glossary).
- **The bridge, `cli/ops/jupyter.rs`.** Thirteen Rust ops forward requests
  over channels. Nearly all are thin wrappers over CDP calls: `evaluate`,
  `callFunctionOn`, `getProperties`, `globalLexicalScopeNames`. The others
  are interrupt (`terminate_execution`), iopub and stdin plumbing, and two
  version strings.
- **Display, `cli/js/40_jupyter.js`.** `Deno.jupyter.display`, `md`,
  `html`, `svg`, `image`, plus `Symbol.for("Jupyter.display")`. It is
  duck-typed JavaScript with four Deno-internal dependencies:
  `inspectArgs`, base64, `readFileSync`, and WebGPU.

[Architecture](architecture.md) describes how cdp-kernel maps onto these
pieces.

![Deno 2.9 runs a kernel isolate and a REPL isolate in one process, joined by 13 Rust ops that are nearly all thin wrappers over CDP calls. cdp-kernel runs a host (Node or Deno) and a target runtime as two processes, joined by CDP over the inspector WebSocket plus stdout and stderr pipes.](images/study/two-halves.svg)

The 13 ops are already CDP in disguise, so swapping the in-process channel
for an `--inspect` WebSocket is the whole trick.

## The extraction: cdp-kernel

The spike was about 2,350 lines of TypeScript and plain ESM, plus about
1,500 lines of tests. It now lives in its own repository,
`tlockney/cdp-kernel`, at about 6,900 lines plus 5,700 lines of tests, and
is published to npm and JSR as `@tlockney/cdp-kernel`. The host runs on
Node 24+ with native type stripping, or on Deno when installed from JSR. Its
runtime dependencies are still esbuild and acorn (with `acorn-walk`). The
kernel host and the target runtime are separate processes:

- The host speaks Jupyter to the frontend.
- The target runs your code.
- The target is launched as `node --inspect=127.0.0.1:0 runtime/bootstrap.mjs`
  or `deno run -A --inspect=… runtime/bootstrap.mjs`. The same bootstrap
  file loads unchanged in both.

### What was ported, what was new

- **Ported almost line for line:**
  - the ZMTP greeting, READY command and framing, keeping Deno's hard-won
    libzmq interop fixes;
  - HMAC sign and verify, dropping forged messages;
  - the shell, control and stdin handlers;
  - completion via `getProperties` and `globalLexicalScopeNames`;
  - the `is_complete` scanner and the codepoint/UTF-16 cursor maths;
  - the whole display formatter, covering DataFrames, Vega, images,
    HTML/SVG elements and the display symbol.
- **Replaced:** swc became esbuild (TS, TSX, enums, JSX, with a TS fallback
  for `<T>x`) plus an acorn pass that rewrites imports, `import()` and
  `import.meta`. On Node, Deno's module loader became a
  `module.registerHooks` resolver: it re-parents cell imports to the
  notebook directory and adds `npm:` (install on first use, one npm alias
  per range) and `jsr:` (mapped onto `npm.jsr.io`).
- **New:**
  - the two-session interrupt;
  - the pipe/WebSocket ordering barrier;
  - synchronous `prompt()` across a process boundary;
  - crash guards;
  - a `Deno.jupyter` proxy on Deno targets;
  - an opt-in `Deno` compatibility namespace on Node.
- **Added since the spike** (each has its own issue):
  - Jupyter comms and anywidget-style widgets, on every target (#9);
  - `inspect_request` tooltips and `history_request` (#10);
  - typings for the `jupyter` global (#11);
  - a notebook's `deno.json` import map, JSX settings and `node_modules` on
    Deno targets (#13);
  - an opt-in lockfile and serialized installs for `npm:`/`jsr:` (#14);
  - JupyterLab's visual debugger on Node and Deno targets, over CDP's
    `Debugger` domain (#18);
  - Bun, workerd and celld targets (#7, #8, #25), and Workers project
    bindings in `env` (#26);
  - on Node, `.ts`, `.tsx` and `.jsx` files imported by a cell compiled
    with esbuild when Node's own type stripping can't run them (#73, #91).

[Runtime integrations](integrations.md) explains the host/target split and
how each runtime is driven, with diagrams.

### The four problems that weren't mechanical

Each was found by probing and fixed in the spike.

| Problem | What happens naively | What cdp-kernel does |
| --- | --- | --- |
| Imports | Code evaluated through the inspector has no module referrer. Node rejects `import()` with "A dynamic import callback was not specified". | Rewrites static imports to `var x = (await __cdpk.import("m")).x`, and routes `import()` and `import.meta` through a function defined in the bootstrap module. A resolve hook re-parents those imports to the notebook directory. |
| Interrupt | While a busy loop runs inside a `Runtime.evaluate` dispatch, the inspector processes no messages on any session, so `terminateExecution` is never seen. This was tested on both Node and Deno. | Each cell first awaits one macrotask, so user code runs as an ordinary task. `terminateExecution` then arrives on a second CDP session. The host abandons the dead evaluate, and state survives: a test counter kept about 466M increments across the interrupt. |
| Output order | `console.log` travels on a pipe and `display()` on the WebSocket, so "after" text overtook the display. This was the first e2e failure. | A numbered [barrier marker](#glossary) goes to both pipes before each display message. The message waits for both markers, and later output waits for the message. |
| Sync `prompt()` | The target is a separate process, so it can't block on the host's stdin channel. | The target sends `input_request` through a CDP binding, then blocks on `readSync` of its own stdin. The host writes the reply as one JSON line. |

### The Deno namespace

On a Deno target, `Deno.jupyter` is a non-configurable getter that throws
outside `deno jupyter`. The `Deno` global itself is configurable, though,
so the bootstrap swaps in a Proxy that answers `jupyter` and forwards
everything else. Existing notebooks run unchanged, and a `jupyter` global is
available everywhere.

On Node, `--deno-compat` installs a separate kernelspec (`cdp-node-deno`).
It provides a `Deno` namespace covering:

- `jupyter`, `version` and `build`;
- `env`, `args`, `cwd` and `chdir`;
- text and binary file I/O, with Node errno codes mapped to `Deno.errors.*`;
- `readDir`, `stat`, `mkdir`, `remove`, `rename`, `realPath`, and temp
  files and directories;
- `inspect`, `stdout` and `stderr`.

::: tip Why opt-in
Libraries detect Deno with `typeof Deno !== "undefined"`. With a shim
present they take their Deno code paths, which may call APIs the shim
doesn't cover (`Deno.serve`, `Deno.Command`, `Deno.openKv`). APIs outside
the shim are simply absent, so feature checks still return false instead of
throwing. Turning it on by default is a one-line change if that trade suits
you.
:::

## Evidence

The e2e suite drives the kernel through Python's `jupyter_client`, which
uses pyzmq and therefore real libzmq, so a pass also proves the pure-JS ZMTP
interoperates. It follows Deno's `tests/integration/jupyter_tests.rs` and
adds the gaps those tests leave. Kernelspecs go into a temporary
`JUPYTER_DATA_DIR`.

*Revised:* the suite has grown from 28 checks on two targets to 275 across
every target, and CI runs it on Linux and macOS against Node 24 and 26 and
Deno 2.9 and the latest 2.x, eight combinations in all. One combination also
runs it against the packed npm tarball and against the host running on
Deno, the two ways the kernel ships.

Conformance suite, CI on main, 2026-10-15 (Ubuntu, Node 26, Deno 2.9):

| Kernelspec | What it adds to the shared checks | Checks |
| --- | --- | ---: |
| node | Protocol, language, display, modules, prompt, interrupt, completion, inspection, history, comms and widgets, debugger breakpoint, `npm:`/`jsr:` and the lockfile | 39/39 |
| deno | As node, plus `Deno.jupyter === jupyter` and the `Deno.*` file APIs; Deno's own lockfile instead of cdp-kernel's | 40/40 |
| node + compat | As node, plus the `Deno` namespace shim | 41/41 |
| deno, in a Deno project | Import map aliases, JSX import source, project `node_modules`; a broken `deno.json` warns once | 14/14 |
| bun | Shared checks without the debugger; interrupt of an awaiting cell keeps state, a busy cell restarts Bun | 39/39 |
| workerd | Shared checks without the debugger or stdin; request-scoped APIs, `fetch`, I/O objects that carry over between cells | 41/41 |
| celld | As workerd | 41/41 |
| workerd and celld, in a Workers project | Project bindings in `env`, a Durable Object stub across cells, the project's own `worker.fetch` | 20/20 |
| **Total** | | **275/275** |

Counts include the shutdown check. The same 275 pass on main on
2026-10-16. The unit suite has grown from 112 to **322 tests** (310 at
0.4.0), covering the original areas plus comms, widgets, the
debugger, source maps, introspection, history, the lockfile, Deno project
config, and each of the Bun, workerd and celld backends. `tsc --strict` is
clean. A separate CI job drives JupyterLab in Chromium through Playwright to
check that widgets render and round-trip in a real frontend on every target,
and that the visual debugger works on Node and Deno.

The spike's original table, from the first run on 2026-10-14: 26/26 checks
on Node, 28/28 on Deno, 28/28 on Node with the compat namespace, and 112/112
unit tests.

### A real Deno-style notebook

`examples/deno-style.ipynb` is written against `deno jupyter`'s APIs. It
uses `import pl from "npm:nodejs-polars@0.18.0"` DataFrames, which are a
native N-API addon, plus a filtered and derived frame, a Vega-Lite v5 chart
object, a `Deno.jupyter.svg` badge, a progress bar updated in place via
`display_id`, a class with `Symbol.for("Jupyter.display")`, and
`Deno.makeTempDir`/`writeTextFile`/`readDir`. Executed by nbclient, it
produced the same output types cell for cell on the Deno target ("Running on
**Deno 2.9.6**, V8 15.0") and on the Node target with the shim ("Running on
**Node 26.8.1**, V8 14.6"). The executed copies sit next to the source
notebook. A second example, `examples/moma-collection.ipynb`, adds `jsr:`
imports, Observable Plot, widgets and server-rendered HTML, executed on Node
and on Deno. Both are on the docs site with their real output:
[A Deno-style notebook](example-deno-style.md) and
[MoMA's collection](example-moma.md).

## Options compared

Seven routes, ranked by how much of the Deno experience they keep for the
effort, and by how well they survive Deno going quiet. *Revised:* the status
and effort columns now show what was built; the ranking is unchanged, and
celld is added. [Choosing a runtime](runtimes.md) compares the targets for
day-to-day use.

| Route | Status | Fidelity to `deno jupyter` | Effort from here | Durability |
| --- | --- | --- | --- | --- |
| **cdp-kernel, Node target** | Released in 0.1 | High: TS, `npm:`/`jsr:`, display API, interrupt, stdin, widgets, debugger. `util.inspect` formatting | Maintenance; Windows (#32) | Node and V8's inspector, both long-lived |
| **cdp-kernel, Deno target** | Released in 0.1 | Highest: Deno's own loader and project config, permissions model off, real `Deno.*` | None beyond the above | Rides the frozen runtime: 2.9.x LTS fixes until October 2027, then a fork's |
| cdp-kernel, workerd target | Released in 0.3 | Medium: cells hoisted onto `globalThis`; a busy-cell interrupt restarts workerd; no debugger or stdin | Maintenance | Cloudflare's stated direction |
| cdp-kernel, celld target | Released in 0.3 | Medium: as workerd, without `--experimental` | Maintenance; celld is young (0.6.2) | Depends on celld's future inside workerd |
| Bun backend | Released in 0.3 | Medium: cells hoisted onto `globalThis`; a busy-cell interrupt restarts Bun; no debugger or compat namespace | Maintenance | Depends on Bun |
| rusty_v8 native host | Assessed ([below](#rusty-v8-and-ffi-surfaces)) | Whatever you rebuild | Large: event loop, module loader, web APIs, inspector wiring | rusty_v8 is supported; the rest is yours |
| Native FFI shell (runtimed) | Assessed ([below](#rusty-v8-and-ffi-surfaces)) | Transport only | Medium, and it solves a solved problem | Good, but unnecessary |
| Adopt tslab or IJavascript | Survey | Low: no Deno display API, no `npm:`/`jsr:`, old TS | Fork and modernize | Stale since 2024 and 2021 |

The ranking turns on one fact. Deno already did the separation, and the seam
it chose ([CDP](#glossary)) is a public, multi-vendor protocol. Every route
that keeps that seam inherits Deno's REPL semantics almost for free. Every
route that drops it has to rebuild them.

## workerd as a target

The probe ran workerd 2026-09-30 (npm `workerd@1.20260930.1`) with
`--inspector-addr` and `--experimental`, and gave the worker an `UnsafeEval`
binding. It compared inspector evaluation against evaluation inside a
`fetch` handler.

| Capability | Inspector `Runtime.evaluate` (no request) | Inside a request (UnsafeEval) |
| --- | --- | --- |
| replMode, const redeclare, resolved top-level await | Works | n/a (function body; needs hoisting) |
| `eval` / `new Function` inside a cell | Works | Works via binding |
| Dynamic `import()`, CDP `addBinding` | Works | — |
| Timers, `fetch`, `crypto.randomUUID` | Fails: "Disallowed operation called within global scope" | Works (fetch needed an outbound network service allowing private addresses) |
| Globals persist between cells | Yes | Yes, across requests |
| Interrupt via second session | No reply; the first session then stopped responding | Untested (CPU limits are the likely lever) |

A notebook needs timers and I/O, so a workerd backend has to run cells
inside a request. workerd marks that context with an [IoContext](#glossary).

The design that follows from the probe:

- A driver Worker exposes `POST /eval`.
- The host hoists each cell's top-level declarations onto `globalThis` (the
  tslab technique) and runs it through `UnsafeEval.newAsyncFunction`.
- Display messages travel back in the response.
- The inspector is used only for completion.

That is a new backend behind the same host, not a change to the protocol
half. If "rusty_v8 in workerd" eventually lets Rust code reach workerd's
inspector or isolate directly, an in-process variant becomes possible.
Nothing public yet says that it will.

### What was built

*Revised.* The workerd target (#8, #26) kept the probe's core idea, cells
evaluated through `UnsafeEval` inside a request with declarations hoisted
onto `globalThis`, and changed the rest:

- **One request, not one per cell.** The host opens a single WebSocket to
  the driver Worker, and every cell runs inside that session's request. I/O
  objects, Durable Object stubs and pending timers then carry over between
  cells, which a `POST /eval` per cell would not allow. The cost is that the
  request never ends, so Workers' per-request CPU and duration limits don't
  apply.
- **No inspector.** Output and display messages come back over the session
  in order. The driver is served on a Unix socket in a private directory,
  opened with a per-launch token.
- **Interrupt.** A cell waiting on a promise is abandoned in place and state
  survives. A busy cell can't be reached, so workerd is stopped and restarts
  on the next cell, losing state.
- **Workers projects.** With a `wrangler` config at or above the notebook,
  the driver runs on the project's own Miniflare, with its bindings in `env`
  and its `main` as `worker`.

celld (#25) runs the same driver Worker over the same session. It allows a
plain global `eval`, so it needs no `--experimental`, and it listens on
loopback TCP rather than a Unix socket. [workerd and celld](integration-workers.md)
describes the target as it works today.

## Bun

Bun 1.4.0's `--inspect` speaks the WebKit Inspector Protocol. Probed
directly:

- `Runtime.evaluate` works.
- `const` redeclaration is tolerated even without `replMode`, because of
  JSC's console semantics.
- Top-level `await` is a SyntaxError.
- `awaitPromise` is ignored.
- `Runtime.addBinding`, `globalLexicalScopeNames` and `terminateExecution`
  do not exist.

A Bun backend would therefore evaluate in-process: wrap cells in async
functions, hoist declarations, report output through a socket back to the
host, and interrupt by restarting the process. The host, wire protocol,
transformer and display module carry over unchanged.

*Revised.* The Bun target (#7) was built this way, with two refinements.
Host and target exchange JSON lines over a pipe on fd 3, which only the host
holds, so there is no port at all. And interrupt only restarts Bun for a
busy cell; a cell waiting on a promise is interrupted in place and keeps its
state. The hoisting has visible edges: a top-level `const` can be
reassigned, and declaring a global's name replaces that global instead of
shadowing it. [Bun](integration-bun.md) describes the target as it works
today.

## rusty_v8 and FFI surfaces

Probed on the study's machine. `Deno.dlopen` (Deno 2.9.6) and `bun:ffi` (Bun
1.4.0) both loaded libSystem and called `getpid()`. Node 26.8.1 has a
`node:ffi` module only behind `--experimental-ffi`. Without the flag, it is
an unknown built-in, so the research sweep's "on by default" was wrong for
this version. With the flag, `dlopen` worked. So one C-ABI library can be
loaded by all three runtimes.

What FFI *can't* do is the important part. A kernel's evaluator has to run
code in the host runtime's own isolate. A [cdylib](#glossary) that links
rusty_v8 brings a *second* V8 with its own heap. It cannot see the host's
globals, modules, or `node_modules`. FFI is useful only for the transport,
and the transport is already solved in pure JS. runtimed's pure-Rust
`jupyter-zmq-client` (reported by the sweep, not opened) is a good reference
implementation, but it isn't needed.

rusty_v8 as the base of a *standalone* kernel binary is coherent but
expensive. The `v8` crate has complete inspector bindings. You would still
build an event loop, a module loader with TS transpile and `npm:`
resolution, console, timers and fetch, which is most of what deno_core is.
deno_core is still shipping releases (0.412 in September, per the sweep),
but nobody has committed to its future. The CDP route reaches a richer
result by borrowing an existing runtime instead.

::: tip Where Rust would earn its keep
A single-binary, dependency-free kernel host: ZMTP plus the Jupyter protocol
in Rust, driving any CDP target. That's a packaging choice, not a capability
gain. It's worth doing only if shipping a Node-based host becomes the
obstacle. *Revised:* the host now also runs on Deno, installed from JSR, and
that obstacle hasn't appeared.
:::

## Risks and gaps

*Revised.* The original list, with what happened to each item:

- **No comms, so no ipywidgets.** *Resolved (#9):* comms work on every
  target, with anywidget-style widgets through `jupyter.widget`. The classic
  ipywidgets controls are Python classes, so they remain unavailable.
- **Formatting differs on Node.** *Kept, deliberately (#17):* each runtime's
  users see the format they expect. On a fixture of 30 typical values, 23
  format identically on Node and Deno; the rest differ in string quotes and
  Node's loader frames in stacks. A test fails if a new kind of difference
  appears.
- **Node `npm:` is simple.** *Partly resolved (#14, #39, #40):* an opt-in
  lockfile pins exact versions, and installs are serialized. The cache is
  still shared, so peer dependencies resolve by real name, and a project's
  `package.json` doesn't decide an `npm:` import's version.
- **Two processes.** Unchanged. The inspector is now private to the host,
  and the workerd and celld sessions are opened with a per-launch token.
- **The interrupt recipe relies on observed V8 inspector behaviour.**
  *Pinned:* CI checks it on every combination of Node 24/26 and Deno
  2.9/latest (#15).
- **Deno targets use `--node-modules-dir=none`.** *Resolved (#13):* a Deno
  target honours the notebook's `deno.json` and project `node_modules`.
- **Not done:** type checking and WebGPU display remain undone. *Done:* the
  debugger (#18), on Node and Deno only, and `inspect_request` content
  (#10), from runtime values rather than TypeScript types.

New since the first compile:

- **Weakly held inspector promises.** With `replMode` or `awaitPromise`,
  V8's inspector holds the result promise only weakly until its callback
  runs, so a GC in that window fails the call with "Promise was collected".
  It broke Deno target startup intermittently (#50, fixed by using plain
  evaluates there). *Resolved (#55):* cells end by yielding one macrotask,
  so the promise settles before anything else can run; synchronous helpers
  drop `awaitPromise`, async ones return a promise the target holds, and
  side-effect-free lookups use plain evaluates.
- **The in-process backends are less faithful.** On Bun, workerd and celld,
  a busy-cell interrupt restarts the runtime and loses state, top-level
  declarations are `globalThis` properties, and only a trailing expression
  shows a result.
- **workerd needs `--experimental`** for `UnsafeEval`, and its cells share
  one request that never ends, so production limits don't apply. A Workers
  project's `main` is bundled with esbuild directly, not with wrangler's
  build.
- **Windows isn't supported** (#32). Unit tests were made portable and
  `npm:` installs now run through `cmd.exe` (#51), but the workerd target
  needs Unix sockets, the e2e suite has never run there, and celld has no
  Windows build. There is no Windows CI job, so the rest waits for a way to
  test on Windows.
- **The Deno target is frozen** (added 2026-10-16). Deno 2.9 gets fixes
  until October 2027 and no features. That is good for stability now, and a
  question for later: past October 2027 the Deno target depends on a fork.
  The Node target, which runs the same notebooks with `--deno-compat`, is
  the long-term home.
- **Little real-world use yet.** The suites are broad, but the kernel is
  new.

[Known gaps](known-gaps.md) keeps the current list of limits.

## Recommended next steps

*Revised.* Four of the five original steps are done:

1. **Promote the spike to its own repo** and publish it to npm and JSR.
   *Done:* `tlockney/cdp-kernel`, released as `@tlockney/cdp-kernel` 0.1.1
   through 0.4.0 with npm provenance.
2. **Ship typings for the `jupyter` global.** *Done (#11).*
3. **Add comms**, so ipywidgets and anywidget work. *Done for anywidget
   (#9).* The kernel now does something `deno jupyter` never did.
4. **Offer it upstream.** No one has claimed the Jupyter kernel in
   denoland/deno#36995 or the forks. A runtime-neutral kernel is useful to
   all of them, and it keeps working whichever fork wins. *Open (#16).*
5. **Only then** consider the workerd hybrid backend or a Bun backend.
   *Done, ahead of step 4:* Bun, workerd and celld targets (#7, #8, #25).

What's next from here (revised 2026-10-16):

1. **Offer it upstream**, as above (#16). Deno's LTS announcement doesn't
   change the pitch: `deno jupyter` gets fixes, not a successor.
2. ~~Close the weak-promise exposure~~ in cell evaluation, comms and the
   debugger. *Done (#55).*
3. **Get real notebooks run on it**, and treat what breaks as the next
   priority list. The fixes for imported TypeScript on Node (#73, #91)
   came this way.
4. **Windows**, if users ask for it and it can be tested (#32).
5. **Plan for the Deno target after October 2027.** Keep Node with
   `--deno-compat` able to run `deno jupyter` notebooks, and follow which
   fork, if any, carries the runtime on.

## Where it landed

Added 2026-10-15, revised 2026-10-16. How the study's predictions held up:

| Prediction | Outcome |
| --- | --- |
| The protocol half and display API port cleanly; CDP is the seam | Held. Node and Deno targets share one bootstrap, and the host now also runs on Deno. |
| Interrupt via a second CDP session keeps state | Held on every CI combination of Node 24/26 and Deno 2.9/latest. |
| workerd needs a request-scoped hybrid backend | Held. Built with one long-lived request instead of one per cell, so I/O carries over between cells. |
| Bun needs an in-process backend; host, transformer and display carry over | Held, as described under [Bun](#bun). |
| Comms are the largest missing protocol feature | Built on every target, with anywidget-style widgets checked in JupyterLab. |
| Formatting differences on Node are small | Measured: 23 of 30 typical values match; kept as is. |
| The remaining risks are known | Not quite. V8's weakly held inspector promises (#50, #55, both fixed) and Windows (#32) weren't foreseen. |
| The Deno runtime gets about a year of fixes, then development ends | Confirmed and dated: 2.9.x LTS until October 2027, no new features (denoland/deno#37030). |
| Bun and workerd backends are optional extras | They were built anyway, plus celld, which the study mentioned only as part of Cloudflare's plans. |

The verdict stands: extract the JS halves and drive the runtime over CDP,
with in-process backends where a runtime can't be driven that way.

## Glossary

- **BYONM**: Bring Your Own `node_modules`: Deno's mode where npm packages
  resolve from a local `node_modules` directory managed by another tool,
  instead of Deno's global cache.
- **Barrier marker**: An escape-delimited sequence number the target writes
  to both stdout and stderr before each display message. The host releases
  the message only once both pipes reach it, and holds later pipe output
  until the message is out.
- **CDP**: Chrome DevTools Protocol: the JSON-over-WebSocket protocol V8
  runtimes expose through `--inspect`. `Runtime.evaluate`,
  `Runtime.callFunctionOn` and friends let an outside process run code in
  the runtime and inspect the results.
- **cdylib**: A Rust crate compiled as a C-compatible dynamic library
  (`.dylib`/`.so`/`.dll`) that any FFI layer can load.
- **IoContext**: workerd's per-request context. Timers, fetch, random values
  and other I/O are only allowed while one is active; code running at global
  scope, including inspector evaluations, has none.
- **kernelspec**: A `kernel.json` file in a Jupyter data directory telling
  frontends how to launch a kernel: argv with `{connection_file}`, display
  name, language, interrupt mode.
- **replMode**: A `Runtime.evaluate` flag in V8's inspector that gives
  console semantics: top-level await, and `let`/`const`/`class` declarations
  that can be redeclared in later evaluations.
- **ZMTP**: ZeroMQ Message Transport Protocol: the wire format ZeroMQ
  sockets speak over TCP. Jupyter frontends use it for all five kernel
  channels. Deno implements the NULL-security subset in plain JavaScript.
