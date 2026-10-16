# Install

Each install writes a Jupyter kernelspec: `cdp-node`, `cdp-deno`,
`cdp-node-deno` (Node with the Deno compatibility namespace), `cdp-bun`,
`cdp-workerd`, or `cdp-celld`. Then pick the kernel in JupyterLab or VS Code.

## From npm

The host runs on Node 24+. CI tests Node 24 and 26 with Deno 2.9
and the latest 2.x, on Linux and macOS. Windows isn't supported yet.

```sh
npm install -g @tlockney/cdp-kernel
cdp-kernel install --runtime node
cdp-kernel install --runtime deno
cdp-kernel install --runtime node --deno-compat
cdp-kernel install --runtime bun
cdp-kernel install --runtime workerd
cdp-kernel install --runtime celld
```

The kernelspec records the absolute paths of `node` and the installed
package. Re-run `install` after upgrading either.

## From JSR

The host runs on Deno:

```sh
deno run -A jsr:@tlockney/cdp-kernel/cli install --runtime deno
```

The kernelspec pins the release it was installed from
(`jsr:@tlockney/cdp-kernel@<version>/cli`). On first launch the target's
runtime modules are copied into the
[runtime-file cache](#files-and-environment).

### Release day on Deno

Deno 2.9+ refuses package versions less than 24 hours old by default
([minimum dependency age](https://docs.deno.com/go/minimum-dependency-age)).
In a release's first day, the install command fails with "blocked by the
minimum dependency age policy". Pass `--min-dep-age=0` to the install
command to get it through:

```sh
deno run -A --min-dep-age=0 jsr:@tlockney/cdp-kernel/cli install --runtime deno
```

The kernelspec it writes works on release day too. It relaunches the kernel
with a dependency cutoff of two days after the release
(`--min-dep-age=<date>`), so it never resolves anything published after
that.

## Target runtimes

Whichever way the host is installed, the target runtime must be present. A
Node target needs `node` on `PATH`, and a Bun target needs `bun` (1.4 is what's
been tested). A workerd target uses the `workerd` in the notebook
directory's `node_modules` (a Workers project has one through wrangler),
or the one on `PATH` (`npm install -g workerd`; 2026-10-15 is what's been
tested). A celld target uses `~/.local/bin/celld`, where celld's installer
puts it, or the one on `PATH` (0.6.2 is what's been tested; celld has no
Windows build).

## Install options

```sh
cdp-kernel install [--runtime RUNTIME] [--deno-compat] [--name NAME] [--display NAME]
```

- `--runtime` is `node` (the default), `deno`, `bun`, `workerd` or `celld`.
- `--deno-compat` adds a partial `Deno` namespace for notebooks written for
  `deno jupyter`. It only applies to `--runtime node`; with any other
  runtime it is ignored. See
  [Notebooks written for Deno](jupyter-api.md#notebooks-written-for-deno).
- `--name` sets the kernelspec's directory name, which is also the name
  Jupyter uses for the kernel. The default is `cdp-<runtime>`, or
  `cdp-node-deno` with `--deno-compat`.
- `--display` sets the name shown in the launcher and kernel picker. The
  default is `TypeScript (cdp-kernel, <runtime>)`.

Installing under an existing name replaces that kernelspec. To keep two
versions side by side, give the second one its own name. A JSR install
pins its release, so this keeps 0.4.0 next to whatever `cdp-deno` runs:

```sh
deno run -A jsr:@tlockney/cdp-kernel@0.4.0/cli install --runtime deno \
  --name cdp-deno-0.4 --display "TypeScript (cdp-kernel 0.4.0, deno)"
```

`cdp-kernel version` prints the installed version.

## Uninstall

Remove a kernelspec with Jupyter, by the name it was installed under:

```sh
jupyter kernelspec list
jupyter kernelspec remove cdp-node
```

Then `npm uninstall -g @tlockney/cdp-kernel` for an npm install. A JSR
install leaves only Deno's module cache behind. The caches below can be
deleted at any time.

## Files and environment

Kernelspecs go in Jupyter's kernels directory:

| Platform | Directory |
| --- | --- |
| Any, when `JUPYTER_DATA_DIR` is set | `$JUPYTER_DATA_DIR/kernels/<name>/` |
| macOS | `~/Library/Jupyter/kernels/<name>/` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/jupyter/kernels/<name>/` |

Each holds one `kernel.json` with the command line Jupyter runs.

The kernel keeps three caches. Deleting any of them is safe; it is
refilled on next use.

| Cache | Location | What's in it |
| --- | --- | --- |
| Runtime files | `${XDG_CACHE_HOME:-~/.cache}/cdp-kernel/runtime/<version>-<hash>/` | The kernel's runtime modules, copied here for a JSR install and for a Deno target of an npm install. One directory per version. |
| npm packages | `~/.cache/cdp-kernel/npm/` | `npm:` and `jsr:` imports on Node and workerd. `CDPK_CACHE_DIR` moves it. |
| Bun packages | `~/.cache/cdp-kernel/bun/` | `npm:` and `jsr:` imports on Bun. |

The npm and Bun caches don't follow `XDG_CACHE_HOME` yet
([#163](https://github.com/tlockney/cdp-kernel/issues/163)). On Deno,
imports use Deno's own cache. See [Writing notebooks](notebooks.md#language-and-imports)
for how the package caches behave.

Environment variables the kernel reads:

| Variable | Effect |
| --- | --- |
| `JUPYTER_DATA_DIR` | Where `install` writes the kernelspec (see above). |
| `XDG_DATA_HOME` | Base of the Linux kernels directory when `JUPYTER_DATA_DIR` isn't set. |
| `XDG_CACHE_HOME` | Base of the runtime-file cache. |
| `CDPK_CACHE_DIR` | Directory of the npm package cache. |
| `ESBUILD_BINARY_PATH` | The esbuild binary used to compile imported `.ts` and `.tsx` files on Node, when the one installed with the package can't be found or shouldn't be used. |
| `CDPK_DEBUG_TRACE` | `1` logs the [debugger](debugger.md)'s protocol traffic to the server log. |

Variables are read by the kernel process, which inherits the
environment of the Jupyter server (or VS Code) that starts it. Set them
there, or in the kernelspec's `env` field (re-running `install` rewrites
`kernel.json` and drops it). Variables named `CDPK_E2E_*`
are for the test suite ([Development](development.md#tests)).

## From a checkout

To run the kernel from a clone of the repository, for working on it, see
[Development › Running from a checkout](development.md#running-from-a-checkout).
