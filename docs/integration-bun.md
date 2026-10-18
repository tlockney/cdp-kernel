# Bun

Bun runs JavaScript on JavaScriptCore, not V8, and its `--inspect` speaks
the WebKit Inspector Protocol instead of CDP. That protocol lacks the
three things the [Node and Deno](integration-cdp.md) integration is built
on: `replMode` (top-level `await` and re-declarable `let`/`const`),
`Runtime.addBinding` (messages from the target), and
`Runtime.terminateExecution` (interrupts). So the Bun target doesn't use an
inspector at all. The host and Bun exchange JSON lines over a private
pipe, and cells are evaluated inside Bun by a small evaluator.

The code is in `src/bun-target.ts` (the host side, `BunTarget`),
`runtime/bun-channel.mjs` (the pipe, in Bun) and `runtime/evaluator.mjs`
(the evaluator, shared with [workerd and celld](integration-workers.md)).
For what all runtimes share, start with
[Runtime integrations](integrations.md).

![The host's BunTarget writes requests to Bun on a pipe at file descriptor 3 and reads replies and iopub messages from it. Bun's stdout and stderr are separate pipes carrying barrier markers, and prompt() replies go to Bun's stdin. Inside Bun, bun-channel.mjs passes requests to evaluator.mjs, which runs cells as global code; bootstrap.mjs installs the shared __cdpk shim.](images/integrations/bun-target.svg)

## Launch

```sh
bun runtime/bootstrap.mjs
```

The host spawns this with four pipes: stdin, stdout, stderr, and a fourth
on file descriptor 3, which becomes the channel. There are no flags. Bun
reads the notebook directory's `bunfig.toml` and `package.json` on its
own, and auto-installs bare imports when there's no `node_modules`.

`bootstrap.mjs` is the same entry module Node and Deno load. It detects
Bun (`globalThis.Bun`), sets up the shared `__cdpk` shim and `jupyter`
namespace, then starts the channel and sends
`{ "kind": "ready", "versions": { ... } }`. The host waits for that line
before running the first cell. Anything Bun prints to stderr before that
line is held back, then passed on; if Bun exits instead, it goes into the
launch error, since it's usually the reason.

The channel has no port and no URL: only the host holds the other end of
fd 3, so nothing else on the machine can reach the target.

## The channel

Each line on fd 3 is one JSON object. The host sends requests:

```json
{ "id": 7, "op": "eval", "code": "var x;\n(async () => { ... })()" }
```

Bun answers each with a reply carrying the same `id`, in whatever order
they finish:

```json
{ "kind": "reply", "id": 7, "result": { "type": "object", "objectId": "h3" } }
```

or, if handling the request threw, `{ "kind": "reply", "id": 7, "failure": "<stack>" }`.
Between replies, `display()` and the other display functions send
`{ "kind": "iopub", ... }` and `{ "kind": "input_request", ... }` lines,
the same messages Node and Deno send as records on stdout.

The requests mirror the CDP calls the kernel makes of the other targets:

| `op` | Does | CDP equivalent |
|---|---|---|
| `eval` | Runs a transformed cell | `Runtime.evaluate` |
| `broadcast` | Formats a result handle as `execute_result` | `callFunctionOn(__cdpk.broadcastResult)` |
| `describe` | Name, message and stack of an error handle | `callFunctionOn(__cdpk.describeError)` |
| `comm` | Delivers a frontend comm message | `callFunctionOn(__cdpk.commDispatch)` |
| `props` | Property names for completion | `Runtime.getProperties` |
| `inspect` | Text for Shift+Tab | `callFunctionOn(__cdpk.describeForInspect)` |
| `barrier` | Writes a barrier marker, returns its number | `Runtime.evaluate(__cdpk.barrier())` |
| `ping` | Answers at once | none; used by interrupts |

Bun writes to fd 3 synchronously (`fs.writeSync`, retrying on `EAGAIN`),
as Node and Deno write their records. That keeps a message's position relative to the
`console.log` calls around it, which the barrier markers depend on.

stdout and stderr are written the same way. Once `process.stdout` exists,
Bun makes the pipes non-blocking and queues output that doesn't fit for its
event loop, which `prompt()`'s blocking read of stdin would stop, so the
bootstrap replaces `process.stdout.write` and `process.stderr.write` with
synchronous writes and `console` with Node's `Console` over them. Console
output on Bun is therefore formatted as on Node.

When the host goes away, fd 3 reaches end-of-file and Bun exits, so a
crashed kernel leaves no orphan behind.

## Handles instead of object ids

CDP returns a value as a `RemoteObject` with an `objectId` that later calls
can refer to. The evaluator imitates this: after an `eval`, it stores the
result (or the thrown error) in a map under a handle such as `h3` and
returns `{ type, objectId: "h3" }`. A later `broadcast` or `describe`
request names the handle, and the evaluator takes the value out of the
map. The map is cleared at the start of each `eval`, so values don't pile
up across cells. With the same shapes as CDP, `src/kernel-core.ts` treats a Bun
target exactly like a Node one.

## Running a cell without replMode

Without `replMode`, the evaluator runs cells as global code with an
indirect `eval`. That brings two problems: global code can't use top-level
`await`, and a `let` or `const` in one `eval` isn't visible to the next.
The host's `transformCellForEval` (in `src/transform.ts`) solves both with
the technique tslab and IJavascript use. It declares every top-level name
with `var` in the outer script, which makes it a property of `globalThis`,
and runs the cell's statements in an async function where those
declarations become assignments:

```ts
// The cell
const { a } = await load();
class K {}
a + 1
```

```js
// What the evaluator runs
var a, K; (async () => { 'use strict';
({ a } = await load());
K = class K {};
return [a + 1];
})()
```

So:

- **Top-level `await` works**, inside the async function.
- **Later cells see earlier declarations**, as globals. So do closures
  created in the cell, because they close over the same global binding.
- **Re-running a cell works**: `var` can be declared again.
- **The last expression is the cell's value**: it becomes
  `return [value]`. The one-element box stops the async function from
  awaiting a promise value, so a cell ending in a promise shows the promise,
  as in Deno.
- **Functions keep their hoisting** and are copied to `globalThis` on
  entry.
- **The cell starts on line 2** of the script, as after the one-line
  prelude on Node and Deno. On every target a stack trace's line number
  is one more than the line in the cell as esbuild compiled it (which
  mostly keeps the cell's lines). Nothing remaps it.

The difference from Node and Deno is that `const` doesn't stay constant
across cells, and these names are global properties rather than lexical
bindings. `lexicalNames()` returns nothing for Bun; completion finds the
names on `globalThis` instead.

Imports are rewritten by acorn as on every target (see
[Cells and module loading](architecture.md#cells-and-module-loading)) and
go through `__cdpk.import`. On Bun that resolves:

- `npm:` and `jsr:` specifiers with the same helpers the Node hooks use,
  installing with `bun add` into `~/.cache/cdp-kernel/bun`.
- Relative paths and URL schemes (`node:`, `bun:`, `file:`) against the
  notebook's directory.
- Bare package names with `Bun.resolveSync` from the notebook's directory,
  so its `node_modules`, or Bun's auto-install, supplies them.

Bun transpiles any TypeScript file a cell imports itself, `enum` included.

## Output ordering

stdout and stderr are ordinary pipes, as on Node and Deno, and fd 3 plays
the part of Node's and Deno's stdout records. So the Bun target uses the same barrier markers and
the same `PipeDemux` and `Gates` classes from `src/target.ts`. See
[Output ordering](integrations.md#output-ordering).

`prompt()` works as on Node: the target sends an `input_request` over fd 3
and blocks on a read of stdin until the host writes the reply.

## Completion and inspection

V8's `throwOnSideEffect` has no equivalent here, so the evaluator avoids
running user code another way. For `obj.<Tab>` and Shift+Tab it resolves a
dotted path such as `a.b.c` one property at a time with
`Object.getOwnPropertyDescriptor`, walking up prototypes, and stops at an
accessor instead of calling it (`resolvePath` in `runtime/introspect.mjs`).
For an expression that isn't a plain path the runtime returns nothing, and
only the kernel's language service, which reads types rather than values,
completes it ([Typed completion](architecture.md#typed-completion-and-inspection)).

## Interrupts

There is no way to stop JavaScript that's running in Bun from outside. The
host tells the two cases apart with a `ping` request:

- **The cell is waiting** (on a timer, a fetch, a promise). Bun's event
  loop is free, so the ping is answered at once. The host rejects the
  cell's pending `eval` with `Interrupted`, and the cell's output ends
  there. Bun and every global stay as they are. Whatever the cell started
  keeps running, so its later output can still appear.
- **The cell is busy** (`while (true) {}`). The ping isn't answered within
  500 ms, so the host kills Bun with `SIGKILL`. The cell's output says:

  ```
  [cdp-kernel] bun was busy and can't be interrupted in place, so it was stopped; it restarts on the next cell, without the earlier cells' state
  ```

  The next cell starts a new Bun.

See [Interrupts](integrations.md#interrupts) for a diagram.

## No debugger

JupyterLab's debugger needs V8's `Debugger` domain, which only the CDP
targets expose, so the Bun kernelspec doesn't advertise one.
