# Debugger

On Node and Deno targets, JupyterLab's visual debugger works: the bug
button in the notebook toolbar, breakpoints in the cell gutter, the call
stack, variables and scopes, stepping, pause on exceptions, the debug
console, and the rich variable viewer. The kernel translates the Jupyter
debug protocol (DAP over `debug_request`) to V8's `Debugger` domain on the
session it already holds (`src/debugger.ts`):

- **Cell paths.** Each cell is named as JupyterLab names it: a temp-dir
  prefix plus the Murmur2 hash of its code (`src/murmur2.ts`, matched
  against ipykernel's). It's evaluated with that name as its
  `//# sourceURL`, so breakpoints bind to the cell and frames point back at
  it.
- **Lines.** Breakpoint and frame lines go through the cell's source map
  (`src/sourcemap.ts`), since esbuild rewrites the TypeScript. A breakpoint
  on a blank or type-only line moves to the next statement.
- **Nothing runs on its own.** The variable explorer between cells reads
  the cells' declarations with V8's side-effect check, so a getter never
  runs. Frames, scopes and the rich viewer evaluate on the paused frame.
- **Kernelspec.** `metadata.debugger` is set for Node and Deno kernelspecs,
  which is what JupyterLab checks. Reinstall older kernelspecs to get it.

`CDPK_DEBUG_TRACE=1` logs every debug request, reply and event to the
Jupyter server's log.

Bun, workerd and celld don't run over an inspector, so they have no
debugger.
