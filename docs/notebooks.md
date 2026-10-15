# Writing notebooks

What a cell can use, on every target unless noted. Per-runtime differences
are in [Runtimes](runtimes.md) and [Known gaps](known-gaps.md).

## Display

`jupyter.display`, `jupyter.md`, `jupyter.html`, `jupyter.svg`,
`jupyter.image`, `jupyter.format`, `jupyter.broadcast`, and
`Symbol.for("Jupyter.display")`: the same API as `Deno.jupyter`.

```ts
await jupyter.display(jupyter.md`# Hello, **notebook**`);
```

`Deno.jupyter` also works:

- On a Deno target it is a proxy over the real namespace. Deno's own
  getter throws outside `deno jupyter`.
- On Node it needs `--deno-compat`. That installs a `Deno` namespace for
  file, env and process APIs (`runtime/deno-compat.mjs`).
- The shim is opt-in because libraries detect Deno with `typeof Deno`, and
  would take Deno code paths that call APIs it doesn't cover.

## Language and imports

Cells accept TypeScript, TSX, enums, top-level `await`, and `const`
redeclaration across cells. Import specifiers can be `./local.ts`, bare
packages from the notebook's `node_modules`, `node:` builtins, and
`npm:pkg@range` or `jsr:@scope/pkg@range`.

- On Node, `npm:` and `jsr:` install on first use into
  `~/.cache/cdp-kernel/npm`. An exact version (`npm:react@19.0.0`) installs
  exactly that version. A range (`npm:react@19`) is resolved the first
  time it's imported and stays at that version, even as other packages
  are installed later. Caches written by cdp-kernel 0.3.0 or earlier
  recorded ranges, which later installs could re-resolve. Delete
  `~/.cache/cdp-kernel/npm` to start fresh. `jsr:` works with npm 12,
  which otherwise refuses JSR's registry tarballs.
- On Deno they use Deno's global cache, unless the notebook is in a
  [Deno project](#deno-projects).
- On Bun they install with `bun add` into `~/.cache/cdp-kernel/bun`. Other
  bare imports resolve from the notebook's directory, so without a
  `node_modules` there, Bun auto-installs them.
- On workerd, the host bundles every import other than a builtin
  (`node:`, `cloudflare:`) with esbuild, using Workers' resolution
  conditions, and sends it with the cell. `npm:` and `jsr:` install into
  the npm cache first, as on Node.

### Lockfile

cdp-kernel 0.4.0 or later. To pin versions, create a `cdp-kernel.lock.json`
in the notebook's directory (or above it) containing `{}`. From then on,
each `npm:`/`jsr:` range is recorded with the exact version it resolved to,
and installed at that version, so the notebook gets the same packages on
another machine. Commit it next to the notebook. Deno targets use Deno's own
resolution and lock instead. Installs into the shared cache are serialized,
so two kernels installing at once can't corrupt it.

## Deno projects

If a `deno.json` or `deno.jsonc` sits in the notebook's directory or above
it, a Deno target uses it, as `deno jupyter` does:

- its import map (`"@/": "./lib/"` aliases, mapped packages);
- its `nodeModulesDir` setting, with `package.json` dependencies from the
  project's `node_modules`;
- its JSX and decorator `compilerOptions`: `jsx` (`react-jsx`,
  `react-jsxdev`, `precompile`, `react`), `jsxImportSource`,
  `jsxFactory`, `jsxFragmentFactory`, `experimentalDecorators`.

The import map wins over `node_modules`, as in Deno. The kernel never
writes to the project's lockfile. A `deno.json` that doesn't parse is
reported in the first cell's output, and the kernel runs as in a plain
directory. Outside a project, the target runs with
`--node-modules-dir=none --no-lock`.

For Workers and celld projects, see [Runtimes](runtimes.md#workers-projects).

## Input and interrupt

`prompt()` and `confirm()` work over the stdin channel, except on workerd.
Interrupt keeps state, except for a busy cell on Bun, workerd or celld
(see [Runtimes](runtimes.md)).

## Inspection, completion and history

**Shift-Tab** shows a tooltip for the name at the cursor: its type, a
function's signature (and its source at the second press), a preview, and
its properties. Nothing is run to get it. On Node and Deno the value is
evaluated with V8's side-effect check (`throwOnSideEffect`), which also
guards completion. Bun, workerd and celld look the name up by property,
without calling getters.

Executed cells are kept for `history_request` (tail, range and search).

## Typed globals in your editor

See [Editor types](editor-types.md).
