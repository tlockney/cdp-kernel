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

Cells accept TypeScript, TSX, enums and top-level `await`. A later cell
can declare a name again with `const`, `let` or `import`, whichever an
earlier cell used: top-level `const` and imports run as `let`, so a
top-level `const` can be reassigned from another cell. A name declared
with `var` or `function` can only be declared again with `var` or
`function`. Import specifiers can be `./local.ts`, bare
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
another machine. Commit it next to the notebook. Deno targets resolve
imports with Deno and keep no lockfile (the kernel runs Deno with
`--no-lock`), so pin a version there with an exact specifier such as
`npm:pkg@1.4.0`. Installs into the shared cache are serialized,
so two kernels installing at once can't corrupt it, and so are updates to
the lockfile, so two kernels recording at once (npm and Bun among them)
keep both entries. If two kernels resolve the same range at once, the
first to record wins; the other keeps the version it installed until it
restarts. While one records, a `cdp-kernel.lock.json.lock`
folder sits beside the lockfile for a moment; don't commit it.

How an import uses the lockfile:

![A cell imports npm:pkg@^1.2. Holding the cache's install lock, the kernel looks for the entry "pkg@^1.2" in cdp-kernel.lock.json. With no lockfile it installs the newest match and records nothing; with no entry it installs the newest match and records the version it resolved to; with an entry of 1.4.0 it installs 1.4.0 exactly. Deno targets don't use the file.](images/concepts/lockfile.svg)

## Deno projects

If a `deno.json` or `deno.jsonc` sits in the notebook's directory or above
it, a Deno target uses it, as `deno jupyter` does:

- its import map (`"@/": "./lib/"` aliases, mapped packages);
- its `nodeModulesDir` setting, with `package.json` dependencies from the
  project's `node_modules`;
- its JSX and decorator `compilerOptions`: `jsx` (`react-jsx`,
  `react-jsxdev`, `precompile`, `react`), `jsxImportSource`,
  `jsxFactory`, `jsxFragmentFactory`, `experimentalDecorators`.

For example, this `deno.json` maps `@/` to `./lib/` and compiles JSX
with the automatic runtime from `my-jsx`, which the import map points at
a local file:

```json
{
  "imports": {
    "@/": "./lib/",
    "my-jsx/jsx-runtime": "./my-jsx/jsx-runtime.ts"
  },
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "my-jsx"
  }
}
```

```ts
// lib/greet.ts
export const greet = (name: string): string => `hello ${name}`;
```

```ts
// my-jsx/jsx-runtime.ts: renders elements to HTML strings
export function jsx(type: string, { children, ...attrs }: Record<string, unknown>): string {
  const attrText = Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
  return `<${type}${attrText}>${[children].flat().join("")}</${type}>`;
}
export const jsxs = jsx;
```

A notebook in that directory, or below it, can then import through the
alias and write JSX:

```tsx
import { greet } from "@/greet.ts";

<b class="greeting">{greet("deno")}</b>
```

```
'<b class="greeting">hello deno</b>'
```

With a JSX library, set `jsxImportSource` to its package instead.

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
restarts the runtime (see [Choosing a runtime](runtimes.md)). Code that
waits on something the interrupt can't reach, such as a comm reply, can
watch [`jupyter.signal`](jupyter-api.md#stopping-on-interrupt-jupyter-signal)
to stop.

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

Where each form comes from:

![Each cell's script is named for its code. When a cell throws, the target's __cdpk.describeError returns the stack, whose frames name those scripts. The host maps each cell frame through the cell's source map to In[n] and the line you wrote, then sends the plain traceback with the structured application/vnd.nteract.traceback+json form in its metadata.](images/concepts/traceback.svg)

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

### Type errors for frontends

The language service can also check the cell being edited against the
cells that ran, for a frontend that shows type errors as you type.
Jupyter has no message for this, so the kernel answers a comm itself,
without running anything in the runtime:

1. The frontend opens a comm to `cdp-kernel.diagnostics.v1` (`comm_open`,
   any `data`). A kernel started with `--no-language-service` closes it
   at once, as for an unknown target.
2. For each check it sends `comm_msg` with `{ request, code }`: `request`
   is any JSON value, sent back to match the answer; `code` is the cell.
3. The kernel answers with `comm_msg` `{ request, diagnostics }`, where
   `diagnostics` is a list of `{ start, end, severity, code, message }`:
   `start` and `end` are offsets in `code` counted in Unicode code points,
   as `cursor_pos` is; `severity` is `"error"` or `"warning"`; `code` is
   TypeScript's error number. `diagnostics` is `null` when the kernel
   can't tell: TypeScript isn't loaded yet or isn't available, the
   runtime's type package (such as `@types/node`) is still loading or
   couldn't be installed (offline), or the check took longer than the
   500 ms budget.

Errors that notebook rules make false are left out: declaring a name that
an earlier cell declared, and importing a package that no cell has run
yet (or one without types). Top-level `await` is allowed. A missing
relative file (`./missing.ts`) is still an error. On the `--deno-compat`
Node kernel, `Deno` has no types, so it is never an error.

The messages go on the shell channel, so a check waits behind a running
cell unless the frontend sends it on a
kernel subshell ([JEP 91](https://github.com/jupyter/enhancement-proposals/blob/master/91-kernel-subshells/kernel-subshells.md)).
A kernel restart closes the comm; open it again.

### Signatures, definitions and renames for frontends

The same language service can show the signature of the call being typed,
jump to where a name is declared, and rename it across the notebook, for a
frontend that offers those. The kernel answers a second comm, again
without running anything in the runtime:

1. The frontend opens a comm to `cdp-kernel.language.v1`. As with the
   diagnostics comm, a kernel started with `--no-language-service` closes
   it at once.
2. It sends `comm_msg` with `{ request, op, ... }`, where `request` is any
   JSON value that comes back with the answer. All offsets are in Unicode
   code points, as `cursor_pos` is.
3. The kernel answers with `comm_msg` `{ request, ... }`, as below.

| `op` | The frontend sends | The kernel answers |
|---|---|---|
| `"signature"` | `code`, `cursor` | `signature`: `{ label, documentation, parameters: [{ label, documentation }], activeParameter }`, or `null` when the cursor isn't inside a call |
| `"definition"` | `cells`, `cell`, `cursor` | `locations`: `[{ cell, start, end }]` |
| `"rename"` | `cells`, `cell`, `cursor`, `newName` | `edits`: `[{ cell, start, end, text }]`, or `error`: a string |

`signature` is checked against the cells that ran, as completion is, and
`code` is the cell being edited. For a call with several signatures it is
the one that fits the arguments so far. `activeParameter` is the index in
`parameters` of the argument at the cursor; it stays on the last parameter
after a rest parameter, and is past the end when the call has more
arguments than the signature has parameters.

`definition` and `rename` don't use the cells that ran. `cells` is the
notebook's code cells in order, with their current text, and `cell` is the
index in `cells` of the one with the cursor, so the answer matches what the
person sees. `start` and `end` are offsets in `cells[cell]` for that
location's `cell`. A definition only has locations inside `cells`: a name
declared in a package's types, in the runtime's globals, or in an imported
file gives `[]`. A rename gives `{ error }` instead of edits when it can't
happen: the name is a keyword, is declared outside the notebook (a package
export, a global such as `process`, a property an imported file
declares), isn't declared in the notebook, is declared only in a later
cell, `newName` isn't a name a declaration can have, or one of the
redeclarations below can't be followed. Apply every edit in `edits`; each replaces `start` to `end` of its
cell with `text`, which is `newName` (`key: newName` where a shorthand
property `{ key }` used the old name, and `name as newName` for an imported
name, which keeps the export's own name).

A name declared again in a later cell isn't an error in a notebook (see
above), and it doesn't stop these. The name at the cursor refers to its
nearest declaration at or before the cell with the cursor, so
`definition` gives that one, and a name in a cell before any declaration
of it has none. `rename` treats the cells that declare a name as separate
variables, as the runtime does: it renames the declaration the cursor's
name refers to and the uses it governs, up to the cell that declares the
name again. The later declarations, and the uses after them, keep the old
name. To rename those too, rename from each of them in turn.

Rename refuses rather than guess where it can't follow a redeclaration:

- A property or other member is found through its variable. If a cell
  between the first and last cell the rename would edit declares that
  variable again (`const o = { k: 1 }`, later `const o = { k: 2 }`), the
  rename fails with `"o" is declared again in a later cell; rename it there
  separately`, as the edits would leave that cell's own `k`.
- When a later cell declares only some of the names a statement declared
  (`const [a, b] = pair`, then `const [a, c] = other`), the earlier
  statement stays in the file, so `a` can't be told apart. `definition`
  gives `[]` for `a`, and `rename` fails with `"a" is declared in more than
  one cell in a way rename can't follow`. `b`, which the later statement
  doesn't declare again, is unaffected.
- The same message answers a name that one cell declares as a value and
  another as a type (`const T = 1`, later `type T = string`): the later
  declaration replaces the earlier one in the file, so the other meaning
  doesn't resolve, and `definition` gives `[]` for it.

Every answer is `null` (`signature`, `locations` or `edits`) when the
kernel can't tell: TypeScript isn't loaded yet or isn't available, the
runtime's type package is still loading or couldn't be installed, or the
check took longer than the 500 ms budget. A request the kernel can't read
(`cells` that isn't a list of strings, a `cell` that isn't an index in
it, no `newName`) gets the same null answer, and an unknown `op` gets
`{ request, error }`. As with diagnostics, the messages go on the shell
channel, and a kernel restart closes the comm.

## Typed globals in your editor

See [Editor types](editor-types.md).
