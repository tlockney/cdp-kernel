# Install

Each install writes a Jupyter kernelspec: `cdp-node`, `cdp-deno`,
`cdp-node-deno` (Node with the Deno compatibility namespace), `cdp-bun`,
`cdp-workerd`, or `cdp-celld`. Then pick the kernel in JupyterLab, VS
Code, or JupyterLab served by
[Ganymede](https://ganymede-server.com/docs/workstation), which needs no
Python.

## From npm

The host runs on Node 22.18+ (the first Node 22 that strips TypeScript
types without a flag). CI tests Node 22, 24 and 26 with the latest Deno
2.x, on Linux and macOS. Windows isn't supported yet. The
[support policy](support.md) says how long each version stays supported.

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

npm 11 may warn that esbuild's postinstall script is "not yet covered by
allowScripts". cdp-kernel works without that script, so you can ignore
the warning; allowing it (`npm install -g --allow-scripts=esbuild …`)
does no harm either.

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

## In a container

[`container/Dockerfile`](https://github.com/tlockney/cdp-kernel/blob/main/container/Dockerfile)
builds an image with JupyterLab, every runtime and kernelspec, anywidget
for [widgets](widgets.md), and the example notebooks. It starts from
[Jupyter's minimal-notebook image](https://jupyter-docker-stacks.readthedocs.io/),
so its options (port, token, user) apply. Each release is published as
`ghcr.io/tlockney/cdp-kernel:<version>` (and `latest`), for amd64 and arm64:

```sh
docker run --rm -p 8888:8888 ghcr.io/tlockney/cdp-kernel
```

Or build it from a clone of the repository:

```sh
docker build -f container/Dockerfile -t cdp-kernel .
docker run --rm -p 8888:8888 cdp-kernel
```

Then open the `http://127.0.0.1:8888/lab?token=...` link it prints. The
examples are in `/home/jovyan/examples`. The image installs the npm release
named by the checkout's `package.json`; add
`--build-arg CDPK_SOURCE=checkout` to build the checkout itself.

## Target runtimes

Whichever way the host is installed, the target runtime must be present. A
Node target runs on the same `node` as an npm-installed host; under a Deno
host (a JSR install) it needs `node` on `PATH`. A Bun target needs `bun`
(1.4 is what's been tested). A workerd target uses the `workerd` in the notebook
directory's `node_modules` (a Workers project has one through wrangler),
or the one on `PATH` (`npm install -g workerd`; 2026-10-15 is what's been
tested). A celld target uses `~/.local/bin/celld`, where celld's installer
puts it, or the one on `PATH` (0.6.2 is what's been tested; celld has no
Windows build).

## Install options

```sh
cdp-kernel install [--runtime RUNTIME] [--deno-compat] [--type-strip STRIPPER] [--no-language-service] [--name NAME] [--display NAME]
```

- `--runtime` is `node` (the default), `deno`, `bun`, `workerd` or `celld`.
- `--deno-compat` adds a partial `Deno` namespace for notebooks written for
  `deno jupyter`. It only applies to `--runtime node`; with any other
  runtime it is ignored. See
  [Notebooks written for Deno](jupyter-api.md#notebooks-written-for-deno).
- `--type-strip` picks what removes types from cells: `esbuild` (the
  default) or `sucrase`, which is plain JavaScript, for a host that can't
  run esbuild's native binary. sucrase doesn't support decorators,
  `accessor` fields or namespaces (other than `declare namespace`); a cell
  that uses them fails with a `SyntaxError`. See
  [Stripping types](architecture.md#stripping-types-typescript-to-javascript).
- `--no-language-service` turns off typed completion and inspection, which
  take about 150 MB while in use. Tab and Shift-Tab then show runtime
  values only. See
  [Inspection and completion](notebooks.md#inspection-completion-and-history).
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

List the kernelspecs cdp-kernel installed, then remove one by the name it
was installed under. Neither needs Jupyter:

```sh
cdp-kernel list
cdp-kernel uninstall cdp-node
```

`list` prints each kernelspec's name, runtime, the cdp-kernel version that
wrote it, and its directory. `uninstall` takes one or more names (or
`--name NAME`); `--all` removes every kernelspec cdp-kernel installed. With
no name it lists them and removes nothing. Both look only at kernelspecs
cdp-kernel wrote, in the [kernels directory](#files-and-environment) that
`install` uses, so set `JUPYTER_DATA_DIR` the same way. Kernelspecs from
other kernels are left alone. From a JSR install, run them as
`deno run -A jsr:@tlockney/cdp-kernel/cli list` and so on.

With Jupyter or Ganymede installed, these do the same:

```sh
jupyter kernelspec list
jupyter kernelspec remove cdp-node

ganymede kernelspec list
ganymede kernelspec remove cdp-node
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
| npm packages | `${XDG_CACHE_HOME:-~/.cache}/cdp-kernel/npm/` | `npm:` and `jsr:` imports on Node and workerd. `CDPK_CACHE_DIR` moves it. |
| Bun packages | `${XDG_CACHE_HOME:-~/.cache}/cdp-kernel/bun/` | `npm:` and `jsr:` imports on Bun. |

On Deno, imports use Deno's own cache. See [Writing notebooks](notebooks.md#language-and-imports)
for how the package caches behave.

Environment variables the kernel reads:

| Variable | Effect |
| --- | --- |
| `JUPYTER_DATA_DIR` | Where `install` writes the kernelspec, and where `list` and `uninstall` look (see above). |
| `XDG_DATA_HOME` | Base of the Linux kernels directory when `JUPYTER_DATA_DIR` isn't set. |
| `XDG_CACHE_HOME` | Base of all three caches. |
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
