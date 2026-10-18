# TypeScript-aware completion and inspection: design note

Issue [#263](https://github.com/tlockney/cdp-kernel/issues/263). Probe:
[`ts-language-service.mjs`](ts-language-service.mjs). Figures below are from
2026-10-18 on Linux x86_64, Node 26.12, Deno 2.9.7.

## Today

`complete_request` and `inspect_request` look at runtime values only
(`src/kernel.ts` `#complete`/`#inspect`, `runtime/introspect.mjs`):

- completion lists the property names of the dotted path before the
  cursor, or globals and lexical names;
- inspection shows a value's runtime type, a signature parsed from
  `Function.prototype.toString`, a preview and property names;
- no declared types, no JSDoc, no completion for a value that doesn't
  exist yet or for anything that isn't a plain dotted path (`[1, 2].map((n)
  => n.toF`), and on Bun, workerd and celld nothing past a getter.

## Proposal

Run the TypeScript language service in the kernel host over a virtual
document: the executed cells, then the cell being edited. Merge its answers
with the runtime ones.

### The virtual document

One file, `<notebook dir>/<session>.cell.ts`, never written to disk. Its
text is:

1. the history: every cell that executed without a syntax error, in
   execution order, with each top-level declaration that a later cell
   redeclares dropped (`const x = 1` then `const x = "s"`: only the second
   stays, so `x.` completes string members);
2. the current cell.

Positions in the request map to the document by adding the history's
length.

Why not the simpler models (both tried in the probe):

- All cells verbatim in one file: a redeclared `const` is an error and keeps
  its first type, and REPL notebooks redeclare all the time.
- One file per cell: a cell with an `import` becomes a module, so later cells
  can't see what it imported or declared.

What's left out: a cell that failed at runtime still counts (its
declarations may or may not exist; the type is still the best guess), and a
name that was declared and then deleted at runtime keeps its type. Both
are acceptable for completion.

### Module resolution

The language service host resolves each import itself
(`resolveModuleNameLiterals`), the same way the target does:

| Specifier | Node, Bun, workerd, celld | Deno target |
|---|---|---|
| `npm:name@range/sub` | the alias installed in the per-user npm cache (`runtime/node-hooks.mjs`) | `deno info --json`: `npmPackages[].localPath` |
| `jsr:@scope/name` | `@jsr/scope__name` in the same cache (npm.jsr.io ships `.d.ts`) | `deno info --json`: the module's `local` path, served under its `https://jsr.io/...ts` name so TypeScript sees a `.ts` file |
| `node:*`, bare names, `./x.ts` | normal Bundler resolution from the notebook directory | same, plus the project's import map |

Resolution never installs anything: a package the target hasn't loaded yet
has no types until the cell importing it runs. That keeps completion from
starting downloads.

### Runtime globals

| Target | Declarations |
|---|---|
| Node | `@types/node` |
| Deno, `cdp-node-deno` | `deno types` (1 MB, from the local Deno, offline, cached per Deno version) |
| Bun | `@types/bun` |
| workerd, celld | the project's `worker-configuration.d.ts` (from `wrangler types`) when there is one, else `@cloudflare/workers-types` |
| all | the kernel's own `dist/globals.d.ts` (`jupyter`, `prompt`, `confirm`) |

A project's own `node_modules/@types/...` wins when present. Otherwise the
package is installed into the per-user npm cache, once, in the background
on the first completion, with the same installer `npm:` imports use. Until
it's there, completion uses `lib.esnext` plus the kernel globals.

### Merging with runtime answers

- `complete_request`: language-service entries first, then runtime names
  it didn't list (it can't know about `globalThis.x = 1` or a dynamic
  property). Each match gets a kind in `metadata._jupyter_types_experimental`
  (`{ start, end, text, type, signature }`), which JupyterLab shows as an
  icon.
- `inspect_request`: the type and JSDoc from quick info, then the runtime
  value preview when the path is a plain one. On Bun, workerd and celld the
  type shows even where the runtime stops at a getter.
- If the service isn't ready, throws, or takes more than a budget (say
  500 ms), the reply is the runtime answer alone, as today.

### Type errors on execute

Possible from the same document (`getSemanticDiagnostics` for the current
cell's range), shown as a warning on stderr before the cell runs. Off by
default, behind a kernelspec flag; Deno doesn't type-check cells either.
Last, and only if asked for.

## Engine: TypeScript 6 in process, or TypeScript 7's LSP server

TypeScript 7 (current `latest` on npm, 7.0.2) is the native port. It has no
in-process language service, only an LSP server (`tsc --lsp --stdio`) and
an API marked unstable. TypeScript 6.0 is the last JavaScript release and
keeps the classic `createLanguageService` API.

Probe results, same notebook (six cells, zod and `@types/node`):

| | TypeScript 6.0.3, in process | TypeScript 7.0.2, LSP child process |
|---|---|---|
| load | `require` 165 ms | spawn + initialize ~20 ms |
| first completion | 580–650 ms | 110–170 ms |
| later completions | 15–40 ms | 5–100 ms |
| quick info | 28 ms | 3 ms |
| memory | +145 MB heap in the kernel host | 75 MB RSS in a separate process |
| package size | 24 MB | 3.6 MB wrapper + 27 MB platform binary |
| control over resolution | full: the host answers every file read and resolution | only through a `tsconfig.json` on disk; `paths` maps `npm:` specifiers, but Deno's hashed JSR cache files can't be served under `.ts` names, and options for a file outside a config (inferred project) weren't settable in a quick test |

TypeScript 7 is faster and lighter, but the language service needs a
virtual file system: the history document, per-target globals, `npm:`/`jsr:`
mapping, and Deno's cache. TypeScript 6 gives that directly; TypeScript 7
would need config files written into a temp directory and specifier
rewriting with position mapping.

**Recommendation: TypeScript 6 now**, behind a small interface
(`complete(doc, pos)`, `quickInfo(doc, pos)`, `diagnostics(doc, range)`)
so the engine can move to TypeScript 7 when its API settles. Run it in a
worker thread of the kernel host, so the first, slow call doesn't block
heartbeats, shell or control messages, and so the worker can be ended to
give its memory back.

## Cost and when to load

- Lazily, on the first `complete_request` or `inspect_request`; never at
  kernel start. That first request gets the runtime answer if the service
  isn't ready within the budget; later ones get types.
- One service per kernel. The document registry is reused between
  requests, so only the changed document is reparsed.
- Memory: about 145 MB while loaded. An idle timeout (say 10 minutes
  without a request) ends the worker.

## Shipping TypeScript

Either way the kernel needs the `typescript` package at run time; today it's
a devDependency only. Options:

1. A dependency: +24 MB to every npm install, always available offline,
   version pinned by the kernel.
2. Installed into the per-user npm cache on first completion, like an
   `npm:` import: no install-size cost, needs network once, completion stays
   runtime-only until it's there (and forever when offline).

From JSR (the CLI run by Deno), `npm:typescript` is fetched when first
imported in both cases.

## Plan

Each step a PR with its own issue:

1. Language service worker and virtual document; `complete_request` merge
   for Node with `@types/node` and `npm:`/`jsr:` from the npm cache.
2. `inspect_request` with type, signature and JSDoc.
3. Globals and resolution for the other targets: Deno (`deno types`,
   `deno info`), Bun, workerd and celld.
4. Docs: known-gaps.md, the Jupyter protocol notes, and the configuration
   to turn it off.
5. Optional type-check warning on execute (only if wanted).
