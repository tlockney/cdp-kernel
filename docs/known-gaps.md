# Known gaps

- Widgets are anywidget-style (`jupyter.widget`). The classic ipywidgets
  controls (sliders, dropdowns) are Python classes, so they're not available.
- Inspection tooltips show what's found at runtime (type, signature,
  preview, properties), not TypeScript types or JSDoc. On Bun, workerd and
  celld, a getter on the path is reported but not called, and completion
  works only on a plain dotted path (`a.b.c`): any other expression
  completes to nothing. History is kept
  for the current kernel session only.
- The debugger is for Node and Deno targets only. Breakpoints are per line,
  conditional breakpoints and logpoints aren't supported, variables can't be
  set from the debugger, and "copy to globals" isn't offered.
- Under [Ganymede](https://ganymede-server.com/docs/workstation), the
  Python-free Jupyter server, notebooks behave as under `jupyter lab`,
  with Ganymede's own
  [known gaps](https://github.com/tlockney/ganymede/blob/main/docs/known-gaps.md).
  The ones a cdp-kernel user meets:
  - A kernel that crashes is reported and removed, not restarted
    automatically.
  - No terminals, and no export to HTML or PDF.
  - Ganymede ships a Windows binary, but cdp-kernel doesn't support
    Windows yet ([#32](https://github.com/tlockney/cdp-kernel/issues/32)),
    so this setup is Linux and macOS only.

  JupyterLab's visual debugger works over Ganymede: breakpoints, the call
  stack and variables were checked on a Node kernel with Ganymede 0.2.0
  and JupyterLab 4.6.4. A Deno kernel's debugger hasn't been tried under
  Ganymede.
- `npm:` on Node, Bun, workerd and celld:
  - one npm alias per `name@range` (or exact version, when locked);
  - the cache is shared by every notebook, so peer dependencies resolve by
    real name from it;
  - a project's own `package.json` doesn't decide an `npm:` import's version
    (bare imports do use its `node_modules`).
- No type checking. Deno doesn't type-check REPL cells either.
- Results are formatted by each runtime's own inspector: `util.inspect` on
  Node, Bun, workerd and celld, and `Deno.inspect` on Deno. On a fixture of
  30 typical values, 23 format identically on Node and Deno. The rest
  differ in two ways:
  - strings are quoted `'…'` on Node and `"…"` on Deno, wherever they
    appear;
  - a displayed `Error`'s stack also lists Node's own module-loader frames.

  That's deliberate: each runtime's users see the format they expect, and
  Node's inspector has no quote-style option, short of porting Deno's
  formatter. `test/formatting.test.ts` runs both runtimes on the fixture
  and fails if a new kind of difference appears
  ([#17](https://github.com/tlockney/cdp-kernel/issues/17)).
- WebGPU texture and buffer display is dropped.
- The `--deno-compat` namespace on Node (`cdp-node-deno`) is partial: it
  covers `Deno.jupyter`, `Deno.env`, and Deno's basic file and process
  functions. Other members (`Deno.serve`, `Deno.Command`, `Deno.open`, …)
  are `undefined` rather than throwing a clear error
  ([#172](https://github.com/tlockney/cdp-kernel/issues/172)), and
  `Deno.version.deno` is `"0.0.0-cdp-kernel"`.
  [Notebooks written for Deno](jupyter-api.md#notebooks-written-for-deno)
  lists what's there.
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
  - No `prompt()` or `confirm()` answers: `prompt()` returns `null` and
    `confirm()` returns `false`, as without a stdin channel. `jupyter.image(path)` can't read files; pass the bytes.
  - Each imported module is bundled with its dependencies. Two imports that
    share a dependency each get their own copy.
  - Interrupting a busy cell restarts workerd and loses state.
  - Top-level declarations and results behave as on Bun: declarations are
    `globalThis` properties, and only a trailing expression shows a result.
  - In a Workers project, `main` is bundled with esbuild directly, not with
    wrangler's build. Custom `build` commands, `alias` and module `rules`
    aren't applied.
- On celld, as on workerd, except:
  - Only the binding and compatibility keys of a project's config (and
    Durable Object `migrations`) are copied. `assets`, `triggers` and `containers` aren't, and neither is
    `.dev.vars`. Relative paths inside the copied keys resolve from
    `.celld/cdp-kernel`, not from the project.
  - Interrupting a busy cell restarts celld and loses state.
