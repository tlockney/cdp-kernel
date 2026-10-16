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
runtime modules are copied into `~/.cache/cdp-kernel/runtime/`.

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
Node target runs on the same `node` as an npm-installed host; under a Deno
host (a JSR install) it needs `node` on `PATH`. A Bun target needs `bun`
(1.4 is what's been tested). A workerd target uses the `workerd` in the notebook
directory's `node_modules` (a Workers project has one through wrangler),
or the one on `PATH` (`npm install -g workerd`; 2026-10-15 is what's been
tested). A celld target uses `~/.local/bin/celld`, where celld's installer
puts it, or the one on `PATH` (0.6.2 is what's been tested; celld has no
Windows build).

## From a checkout

To run the kernel from a clone of the repository, for working on it, see
[Development › Running from a checkout](development.md#running-from-a-checkout).
