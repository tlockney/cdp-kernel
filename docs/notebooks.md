# Writing notebooks

What a cell can use, on every target unless noted. Per-runtime differences
are in [Choosing a runtime](runtimes.md) and [Known gaps](known-gaps.md).

## Display

A cell's last expression is shown as its result. The global `jupyter`
renders richer output: Markdown, HTML, SVG, images, charts and tables, and
updates to output already shown.

```ts
await jupyter.display(jupyter.md`# Hello, **notebook**`);
```

It's ported from Deno's `Deno.jupyter`, and on Deno targets `Deno.jupyter`
is the same object.
[The `jupyter` namespace](jupyter-api.md) explains it with examples,
along with `prompt()`, `confirm()` and running notebooks written for Deno.

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

Standard (TC39) decorators and `accessor` fields work on every target
without configuration: the cell transform compiles them to plain
JavaScript. `experimentalDecorators: true` selects TypeScript's legacy
decorators instead.

For Workers and celld projects, see [Choosing a runtime](runtimes.md#workers-projects).

## Interrupt

**Kernel › Interrupt** (the ■ button) stops the running cell and keeps
your variables, except for a busy cell on Bun, workerd or celld, which
restarts the runtime (see [Choosing a runtime](runtimes.md)).

## Errors

When a cell throws, the traceback points at cells by their execution
count and at the line you wrote, TypeScript types included, even for a
function an earlier cell defined:

```
RangeError: tb 2
    at failing (In[3]:3)
    at In[4]:3
```

The error message also carries a structured form of the traceback in its
metadata, under `application/vnd.nteract.traceback+json` (the payload
[nteract](https://github.com/runtimed/runt/blob/main/docs/adr/traceback-output-protocol.md)
defines): each frame's file, line, function name, a few source lines with
the failing one marked, the cell's execution count and `cellId` when the
frame is in a cell, and a `library` flag for frames in packages, the
runtime and the kernel. Frontends that don't read it show the plain
traceback.

## Inspection, completion and history

**Tab** completes from two sources. TypeScript's language service reads
the cells you've run plus the one you're editing, so it knows declared
types: `user.` lists a `User`'s fields even before `user` has a value,
completion works inside expressions such as `[1, 2].map((n) => n.toF`, and
imported packages complete from their declarations. The runtime then adds
names only it knows, such as a property set at runtime. JupyterLab shows
each match's kind (method, property, variable, ...) beside it.

**Shift-Tab** shows a tooltip for the name at the cursor: its declared type,
signature and JSDoc, then the runtime's view of the value, a preview and its
properties (and a function's source at the second press). Nothing is run to
get it. On Node and Deno the value is evaluated with V8's side-effect check
(`throwOnSideEffect`), which also guards completion. Bun, workerd and celld
look the name up by property, without calling getters.

Types for each runtime's globals and for your imports come from:

| Runtime | Globals | `npm:` and `jsr:` imports |
|---|---|---|
| Node | `@types/node` | the kernel's package cache |
| Deno | `deno types` | Deno's cache, found with `deno info` (the project's import map applies) |
| Bun | `@types/bun` | Bun's package cache |
| workerd, celld | the project's `worker-configuration.d.ts` (`wrangler types`), else `@cloudflare/workers-types` | the kernel's package cache |

A type package your project already has (in its `node_modules`) is used as
is. Otherwise it's installed once into the kernel's package cache, in the
background; until then, and when offline, completion goes on without it.
Looking up types never downloads a package your cells haven't imported.

The language service runs in a worker thread. It starts on the first Tab or
Shift-Tab, which is answered from the runtime alone while it loads (well
under a second), and stops after 10 minutes without a request. While it
runs it takes about 150 MB. To turn it off, install the kernel with
`--no-language-service` ([Install options](install.md#install-options)).

Executed cells are kept for `history_request` (tail, range and search).

## Typed globals in your editor

See [Editor types](editor-types.md).
