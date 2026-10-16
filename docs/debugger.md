# Debugger

On Node and Deno kernels, JupyterLab's visual debugger works as it does
for Python. Bun, workerd and celld don't run over an inspector, so they
have no debugger.

## Using the debugger

1. Click the bug button in the notebook toolbar to turn debugging on. The
   debugger panel opens in the right sidebar.
2. Click in a cell's gutter, left of the line numbers, to set a
   breakpoint. Breakpoints are per line; a breakpoint on a blank or
   type-only line moves to the next statement.
3. Run the cell. Execution stops at the breakpoint, and the panel shows the
   call stack, the variables in each scope, and the source.
4. Step over, into or out of calls, or continue, from the panel's toolbar.
   Turn on pause on exceptions there to stop wherever an error is thrown.

While paused, the debug console evaluates expressions in the paused frame,
and the variable explorer can open a value in the rich viewer. Between
cells, the explorer lists the variables the cells have declared.

Lines refer to the TypeScript you wrote, even though the kernel compiles it
before running it.

If the bug button doesn't appear, the kernelspec predates debugger support:
re-run `cdp-kernel install` for that runtime.

Not supported: conditional breakpoints, logpoints, setting variables from
the debugger, and "copy to globals". See [Known gaps](known-gaps.md).

## How it works

The kernel translates the Jupyter debug protocol (DAP over
`debug_request`) to V8's `Debugger` domain on the CDP session it already
holds (`src/debugger.ts`):

- **Cell paths.** Each cell is named as JupyterLab names it: a temp-dir
  prefix plus the Murmur2 hash of its code (`src/murmur2.ts`, matched
  against ipykernel's). It's evaluated with that name as its
  `//# sourceURL`, so breakpoints bind to the cell and frames point back at
  it.
- **Lines.** Breakpoint and frame lines go through the cell's source map
  (`src/sourcemap.ts`), since esbuild rewrites the TypeScript.
- **Nothing runs on its own.** The variable explorer between cells reads
  the cells' declarations with V8's side-effect check, so a getter never
  runs. Frames, scopes and the rich viewer evaluate on the paused frame.
- **Kernelspec.** `metadata.debugger` is set for Node and Deno kernelspecs,
  which is what JupyterLab checks.

`CDPK_DEBUG_TRACE=1` logs every debug request, reply and event to the
Jupyter server's log. [Node and Deno](integration-cdp.md#the-debugger)
covers how this fits with the rest of the CDP integration.
