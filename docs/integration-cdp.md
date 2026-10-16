# Node and Deno

Node and Deno targets are driven the way `deno jupyter` drives its own REPL
isolate: over the Chrome DevTools Protocol (CDP), the protocol behind
`--inspect` and Chrome's DevTools. The host launches the runtime with its
inspector on, connects to the inspector's WebSocket, and runs every cell
with `Runtime.evaluate`. The code is in `src/target.ts` (the `Target`
class), `src/cdp.ts` (a small CDP client) and `runtime/bootstrap.mjs` (what
the target loads). For what the pieces have in common with the other
runtimes, start with [Runtime integrations](integrations.md).

![The host holds two CDP sessions on the target's inspector WebSocket, a shell session for evaluation and a control session for interrupts, and reads the target's stdout and stderr pipes. It writes prompt() replies to the target's stdin. Inside the target, runtime/bootstrap.mjs installs globalThis.__cdpk.](images/integrations/cdp-target.svg)

## Launch

The host spawns one of:

```sh
node --inspect=127.0.0.1:0 --inspect-publish-uid=stderr runtime/bootstrap.mjs
deno run --allow-all --node-modules-dir=none --no-lock \
  --inspect=127.0.0.1:0 --inspect-publish-uid=stderr runtime/bootstrap.mjs
```

(`launchCommand` in `src/target.ts`.) Each flag has a reason:

- **`--inspect=127.0.0.1:0`** binds the inspector to loopback on a free
  port, so several kernels never collide.
- **`--inspect-publish-uid=stderr`** keeps the inspector's URL private.
  CDP has no authentication: whoever holds the WebSocket URL can run code
  in the target. By default the inspector also lists the URL at
  `http://127.0.0.1:<port>/json/list`, where any local process could read
  it. With this flag the URL, which ends in a random UUID, appears only on
  the target's stderr, and only the host reads that pipe.
- **Deno: `--node-modules-dir=none --no-lock`.** Deno looks for a config
  file next to the main module, which is this package. `none` gives the
  global-cache behaviour `deno jupyter` has in a plain directory, and
  `--no-lock` stops Deno from writing a `deno.lock` into the package.
- **Node: the binary.** Under a Node host, the target is the same `node`
  as the host (`process.execPath`). Under a Deno host it is `node` on
  `PATH`.

The child gets `FORCE_COLOR=1` (and no `NO_COLOR`), so `console.log` of an
object is colored as in a terminal; Jupyter renders ANSI colors.

The host then reads stderr until the `ws://` URL appears, connects, and
waits for `bootstrap.mjs` to finish its top-level `await`s by polling
`typeof globalThis.__cdpk?.tick === "function"`. It records the runtime and
V8 versions (shown in `kernel_info_reply`) and the names of the runtime's
own globals, which the debugger's variable view leaves out. If any of this
takes over 60 seconds, the host kills the child, closes its sockets, and
reports the failure.

The inspector's own notices ("Debugger listening on ...", "Debugger
attached.") and Deno's `Download https://...` progress lines are filtered
out of stderr, so they don't show up in the notebook.

## Two sessions

The host opens two CDP sessions on the same WebSocket URL:

- **shell** carries everything ordinary: `Runtime.enable`,
  `Runtime.addBinding`, `Runtime.evaluate`, `Runtime.callFunctionOn`,
  `Runtime.getProperties`, and the `Debugger` domain while debugging. It
  also receives events: `Runtime.bindingCalled` and `Debugger.paused`.
- **control** is used for one thing: `Runtime.terminateExecution`. While a
  cell runs, the shell session is waiting on its `Runtime.evaluate`, so an
  interrupt needs a session that isn't.

## Running a cell

The host transforms the cell with `transformCell` (esbuild strips types,
acorn rewrites `import`/`export`; see
[Cells and module loading](architecture.md#cells-and-module-loading)) and
adds two lines:

```js
'use strict'; await __cdpk.tick();
// ...the cell...
;let __cdpk_settled = await __cdpk.tick();
```

It then sends:

```json
{ "method": "Runtime.evaluate",
  "params": { "expression": "...", "contextId": 1, "replMode": true, "awaitPromise": true } }
```

`replMode` is the inspector feature Chrome's console and Deno's REPL use.
It allows top-level `await`, and lets `let`, `const` and `class`
declarations live on between evaluations and be declared again, as when
you re-run a cell. It is why Node and Deno need no hoisting tricks.

The two added lines solve problems with that call:

- **The leading tick** yields one macrotask, so the cell runs as an
  ordinary task rather than inside the inspector's dispatch of
  `Runtime.evaluate`. Inside that dispatch the inspector reads no other
  message, so an interrupt would wait until a busy loop ended.
- **The trailing tick** lets the script settle with nothing queued ahead
  of the inspector's own callback. The inspector holds the result promise
  only weakly until that callback runs; a garbage collection in between
  fails the call with "Promise was collected"
  ([#55](https://github.com/tlockney/cdp-kernel/issues/55)). A declaration has no
  completion value, so the cell's value is unchanged.

The reply is a `RemoteObject` or `exceptionDetails`. The host then:

- On an exception, calls `__cdpk.describeError(e)` with
  `Runtime.callFunctionOn` to get the name, message and stack, and
  publishes an `error` message.
- Otherwise, unless the value is `undefined`, calls
  `__cdpk.broadcastResult(count, value)` the same way. This runs in the
  target, where `display.mjs` can call the value's display hooks, and
  sends `execute_result` through the binding.
- Calls `flush()`: one `__cdpk.barrier()` evaluation, then waits until
  both pipes and every pending message have caught up to that barrier.
  Only then does it send `execute_reply`.

Calls that return a promise go through `__cdpk.hold()`, which keeps the
promise referenced until a macrotask after it settles, for the same
garbage-collection reason as the trailing tick. Calls that return a plain
value use plain `Runtime.evaluate` or `callFunctionOn` without
`awaitPromise`, for the same reason
([#50](https://github.com/tlockney/cdp-kernel/issues/50)).

## Messages back to the host

`Runtime.addBinding({ name: "__cdpk_send" })` installs a function
`globalThis.__cdpk_send` in the target. When code calls it with a string,
the inspector fires `Runtime.bindingCalled` on the shell session with that
string as the payload. `bootstrap.mjs` sends two kinds of message this way:

- `{ kind: "iopub", msg_type, content, metadata, buffers, barrier }`:
  `display_data`, `update_display_data`, `execute_result` and comm
  messages, published by the host on iopub as they are.
- `{ kind: "input_request", prompt, password, barrier }`: `prompt()`,
  `confirm()` and password input.

Every message carries a barrier number, and the target writes the matching
marker to stdout and stderr just before sending it. The host's
`PipeDemux` uses the markers to keep pipe output and messages in order.
[Output ordering](integrations.md#output-ordering) shows how.

## Synchronous input

`prompt()` must return a string synchronously, as in a browser and in
Deno. The target sends an `input_request` through the binding, then blocks
on a byte-at-a-time `readSync` of its own stdin until a newline arrives.
The host forwards the request to the frontend on the stdin socket and
writes the reply to the child's stdin as one JSON line,
`{"value":"..."}`, or `{"value":null}` if the frontend has no stdin or the
user cancelled. The host always answers exactly once, so the read
returns.

## Completion and inspection

Neither completion nor Shift+Tab inspection should run user code: typing
`obj.` must not call a getter that changes state.

- **Properties** (`obj.<Tab>`): `Runtime.evaluate` of `(obj)` with
  `throwOnSideEffect: true`, so V8 refuses to run anything that writes,
  then `Runtime.getProperties` on the result.
- **Names** (`<Tab>` at the top level): `Runtime.globalLexicalScopeNames`
  for the cells' `let`, `const` and `class` names, plus the global object's
  properties.
- **Inspection**: the same side-effect-free evaluate finds the value, and
  `__cdpk.describeForInspect` formats it.

## Interrupts

`interrupt()` resumes the target first if the debugger has it paused (a
paused isolate runs nothing to terminate), sends
`Runtime.terminateExecution` on the control session, and rejects the
pending `Runtime.evaluate` on the shell session. A terminated script never
settles the promise the inspector is waiting for, so the host abandons the
call and ignores any late reply. The session stays usable, the target
keeps running, and every earlier cell's state survives, whether the cell
was busy or waiting.

## Errors outside a cell

An exception thrown later by a timer or an unhandled promise rejection
would end a Node process. `bootstrap.mjs` registers `uncaughtException`
and `unhandledRejection` handlers (in Deno, `error` and
`unhandledrejection` listeners that call `preventDefault()`) and prints
the error to stderr, so it shows up in whichever cell is running, and the
kernel survives.

A `setInterval` keeps the event loop alive between cells.

## Node specifics

**Module resolution.** Code evaluated over the inspector has no module of
its own, so Node rejects a bare `import()` in it. The cell transform turns
every import into `__cdpk.import(...)`, which calls `import()` from
`bootstrap.mjs`. `runtime/node-hooks.mjs` then registers a synchronous
resolve hook (`module.registerHooks`) that:

- Re-parents imports made from the bootstrap module to the notebook's
  directory, so `./util.ts` and bare package names resolve from where the
  notebook is.
- Handles `npm:name@range` by installing the package on first use into
  `~/.cache/cdp-kernel/npm`, under an alias per request, so two ranges of
  one package can coexist. A `cdp-kernel.lock.json` pins versions
  ([Writing notebooks](notebooks.md)).
- Maps `jsr:@scope/name` to JSR's npm registry as `@jsr/scope__name`.

Files a cell imports are loaded by Node itself, which strips TypeScript
types; the same hook compiles a file with `enum` or similar syntax with
esbuild ([Imported TypeScript files](architecture.md#imported-typescript-files)).

**The Deno namespace.** A kernel installed with `--deno-compat` sets
`CDPK_DENO_COMPAT=1`, and `bootstrap.mjs` installs a partial `Deno` global
from `runtime/deno-compat.mjs`, for notebooks written for `deno jupyter`.

## Deno specifics

**Projects.** If a `deno.json` or `deno.jsonc` is at or above the
notebook's directory, the host launches Deno with `--config <path>`
instead of `--node-modules-dir=none`, so the project's import map,
`nodeModulesDir` and other settings apply as in `deno jupyter`. Its
`compilerOptions` for JSX and decorators are passed to esbuild for the
cell transform (`src/deno-config.ts`). Standard decorators are always
lowered by esbuild, since neither acorn nor V8 parses them yet. A config
that can't be read is reported in the first cell, and the kernel runs
without it.

**Resolution.** Deno resolves `npm:`, `jsr:`, URLs and import maps itself.
`bootstrap.mjs` only resolves relative specifiers against the notebook's
directory first, since Deno would otherwise resolve them against
`bootstrap.mjs`. In a project, a bare name that Deno can't place is
retried from the project's `node_modules` (`runtime/node-modules-resolve.mjs`):
Deno resolves `package.json` dependencies relative to the importing
module, which here is outside the project.

**Copied runtime files.** Deno ignores a project's import map for modules
loaded from under a `node_modules` directory. When the host was installed
from npm, its `runtime/` files are in one, so the host copies them out to
`~/.cache/cdp-kernel/runtime/` before launching a Deno target.

**`Deno.jupyter`.** Outside `deno jupyter`, `Deno.jupyter` is a getter
that throws. `bootstrap.mjs` replaces the `Deno` global with an object
whose own `jupyter` is cdp-kernel's namespace and whose prototype is the
real `Deno`, so existing notebooks that use `Deno.jupyter.display` keep
working, and completion and Shift-Tab on `Deno.` find the real namespace's
members. `Object.keys(Deno)` and `console.log(Deno)` show only `jupyter`.

## The debugger

Because the host already holds a CDP session, JupyterLab's visual debugger
works on Node and Deno: `src/debugger.ts` translates the Jupyter debug
protocol to the V8 `Debugger` domain on the shell session. See
[Debugger](debugger.md).
