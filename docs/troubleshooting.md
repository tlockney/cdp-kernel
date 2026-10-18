# Troubleshooting

Symptoms, what causes them, and what to do. If something here doesn't
match what you see, the kernel's own messages in the server log usually
say more.

## Where the kernel's messages go

The kernel writes its diagnostics to standard error, prefixed with
`[cdp-kernel]` (or `[cdp-kernel workerd]`, `[cdp-kernel celld]` for those
runtimes' own output). The program that started the kernel collects it:

- **JupyterLab or Jupyter Notebook**: the terminal you ran `jupyter lab` in.
- **Ganymede**: the terminal you ran `ganymede lab` or `ganymede serve`
  in, each line prefixed with `[kernel <id>]`. `--quiet` discards them.
- **VS Code**: the **Output** panel, with **Jupyter** picked in its
  drop-down.

Cell output never goes there, and those messages never appear in a cell
unless noted below.

## The kernel isn't in the launcher or kernel picker

1. Run `cdp-kernel list` (or `jupyter kernelspec list`, or
   `ganymede kernelspec list`). The cdp-kernel kernels are named
   `cdp-node`, `cdp-deno`, `cdp-node-deno`, `cdp-bun`, `cdp-workerd` and
   `cdp-celld`, unless installed with `--name`.
2. If it's missing, run `cdp-kernel install --runtime <runtime>` again
   (see [Install](install.md)).
3. If it's listed but the frontend doesn't show it, the frontend may be
   looking in a different place. That happens when Jupyter runs in a
   virtual environment or container, or with `JUPYTER_DATA_DIR` set
   differently from where `install` ran. Run `install` in the same
   environment as the frontend.
4. Restart JupyterLab, or in VS Code run **Developer: Reload Window**:
   both read the kernel list at startup. Under Ganymede,
   `ganymede kernelspec paths` prints the directories it searches.

## The kernel starts, then dies or never becomes ready

The kernelspec records absolute paths: the `node` or `deno` that ran
`install`, and where the package was installed. After upgrading Node
(including switching versions with nvm, fnm or similar), Deno or
cdp-kernel, those paths can stop existing. Re-run `install` for each
runtime you use. `cdp-kernel list` shows each kernelspec's
directory; its `kernel.json` shows the command Jupyter runs.

On release day, a JSR install can fail with "blocked by the minimum
dependency age policy"; see
[Install › Release day on Deno](install.md#release-day-on-deno).

## "target failed to start" in the log

The kernel process is running, but it couldn't start the runtime your code
runs in (the target). The rest of the line says why. The usual causes:

- The runtime isn't installed or isn't where the kernel looks for it:
  `bun` on `PATH`, `workerd` in the notebook folder's `node_modules` or on
  `PATH`, `celld` in `~/.local/bin` or on `PATH`, or, under a JSR install,
  `node` on `PATH`. See [Install › Target runtimes](install.md#target-runtimes).
- The runtime started but exited before it was ready, or took too long.
  The message includes what it printed, such as a version it refuses or
  a config error.

A Workers or celld project whose config can't be read doesn't stop the
target: the kernel runs without the project's bindings and says so in the
first cell's output.

The first cell you run then fails with a `KernelError` carrying the same
message (see below).

## A cell fails with `KernelError`

A `KernelError` is a failure of the kernel itself, not an error your code
threw: errors from your code keep their own names (`TypeError`,
`SyntaxError`, …). The message says what went wrong, most often that the
target couldn't start, such as `bun exited (1) before it was ready` or
`… did not start within 60s`. Fix the cause the message names, then run
the cell again; the kernel tries to start the target again on each cell.
If it keeps happening, restart the kernel and check the server log.

## "exited; restarting on next cell"

```text
[cdp-kernel] node exited (1); restarting on next cell
```

The runtime running your cells stopped: your code called `process.exit()`,
it ran out of memory, or it crashed. The next cell starts a fresh one, so
variables and imports from earlier cells are gone. Run the notebook again
from the top.

On Bun, workerd and celld, interrupting a cell that's busy computing (not
awaiting) has the same effect, with its own notice: "was busy and can't be
interrupted in place, so it was stopped". See [Known gaps](known-gaps.md).

## Packages: wrong version, or a broken install

`npm:` and `jsr:` imports install into a cache shared by every notebook
([Install › Files and environment](install.md#files-and-environment) lists where). Deleting a cache is
always safe; it's refilled on next use.

| Symptom | Clear |
| --- | --- |
| An `npm:` or `jsr:` import on Node or workerd gets an unexpected version, or fails after an interrupted install | `~/.cache/cdp-kernel/npm` |
| The same on Bun | `~/.cache/cdp-kernel/bun` |
| The same on Deno | Deno's cache: `deno clean` |
| A JSR install, or a Deno target of an npm install, behaves like an older cdp-kernel after an upgrade | `~/.cache/cdp-kernel/runtime` |

Caches written by cdp-kernel 0.3.0 or earlier recorded version ranges that
later installs could re-resolve; clear the npm cache once after upgrading
from those. To pin versions per notebook instead, use a
[lockfile](notebooks.md#lockfile).

## Uninstalling

Remove each kernelspec by name, then the package:

```sh
cdp-kernel uninstall cdp-node    # or --all for every cdp-kernel kernelspec
npm uninstall -g @tlockney/cdp-kernel
```

`jupyter kernelspec remove cdp-node` and `ganymede kernelspec remove
cdp-node` work too.

The caches under `~/.cache/cdp-kernel` can be deleted too.
