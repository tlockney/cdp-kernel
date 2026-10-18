# Support policy

cdp-kernel is early software, at version 0.x. This page says what it runs
on, which parts can change before 1.0 and how you'll hear about it, and
what has to be true before it's called 1.0.

## Runtimes

The kernel has two halves (see [Choosing a runtime](runtimes.md)): the
**host**, which talks to Jupyter, and the **target**, which runs your
cells. A version is supported when CI runs the whole test suite on it, on
Linux and macOS, for every pull request.

| | Supported | Tested today |
| --- | --- | --- |
| Host: Node | Node release lines in active or maintenance LTS, and the current release (22 from 22.18) | 22, 24, 26 |
| Host: Deno | The latest Deno 2 minor release | latest 2.x |
| Target: Node | The `node` that runs the host | 22, 24, 26 |
| Target: Deno | The latest Deno 2 minor release | latest 2.x |
| Target: Bun | The latest Bun minor release | 1.4 |
| Target: workerd | The version CI pins | 2026-10-15 |
| Target: celld | The version CI pins | 0.6.2 |

How support follows the runtimes' own releases:

- **A new Node major, or a new Deno or Bun minor.** It's added to CI once
  the suite passes on it, normally within two weeks of its release. Until
  then it may work, but a bug found only there isn't treated as urgent.
- **An old Node line** stops being supported when Node ends its support
  (end of life). Its CI job is removed in the next cdp-kernel release, and
  that release raises `engines` in `package.json`.
- **Deno and Bun** have one supported minor at a time: the newest. When a
  new one is added, the previous one is dropped from CI.
- **workerd and celld** are pinned in CI, because each new release can
  change the behaviour the kernel relies on. The pin moves forward when
  someone tests a newer release; the version in the table is the one
  [Install › Target runtimes](install.md#target-runtimes) names.

Several things the kernel depends on were found by probing each runtime
rather than read in its documentation (interrupting over a second
inspector session, Node's module hooks, Deno's `Deno` global). A runtime
release can change them without notice, so a new release isn't assumed to
work until CI has run on it.

**Operating systems:** Linux and macOS. Windows isn't supported yet
([#32](https://github.com/tlockney/cdp-kernel/issues/32)).

## Frontends

A frontend is the program you open notebooks in. The kernel speaks the
standard Jupyter protocol, so any frontend should work; these are the ones
it's checked against:

- **Tested in CI:** JupyterLab 4 (widgets and the debugger, in a real
  browser), and `jupyter_client`/`nbclient`, which the conformance suite
  runs through.
- **Supported, not yet tested in CI:** VS Code with the Jupyter extension,
  Jupyter Notebook 7 (built from the same components as JupyterLab), and
  tools built on `nbclient`, such as `papermill` and `jupyter nbconvert
  --execute`.

A bug in a frontend from either list is a cdp-kernel bug until shown
otherwise. For other frontends, reports are welcome, but fixes depend on
someone being able to reproduce them.

## What may change before 1.0

Releases are numbered `0.MINOR.PATCH`. Before 1.0:

- a **minor** release (0.5 → 0.6) may change any of the things below;
- a **patch** release (0.5.0 → 0.5.1) only fixes bugs and adds things.

Every change you might have to act on is listed at the top of its
release's [changelog](changelog.md) entry under "Changes in behavior",
with what to do about it.

From least to most likely to change:

1. **The `jupyter` namespace** in notebooks (`jupyter.display`,
   `jupyter.md`, `jupyter.html`, `jupyter.widget`, …). It follows the API
   of `deno jupyter`, and notebooks written for one should keep working on
   the other, so changes here are rare and follow Deno's.
2. **Kernelspec names** (`cdp-node`, `cdp-deno`, …). Notebooks record the
   kernel name, so renaming one would break saved notebooks; it would only
   happen with the old name kept working for at least one minor release.
3. **The command line**: `cdp-kernel install`, `list`, `uninstall`,
   `version` and their flags. A flag may be renamed or removed. What a
   kernelspec runs (`cdp-kernel kernel …`) can change too, in which case
   the release notes ask you to re-run `install`.
4. **The library API**: what `@tlockney/cdp-kernel` exports for embedding
   the kernel in another program (`Kernel`, `parseConnectionInfo`, the
   type-stripper and transform options). This is the least settled part.

Anything else, such as files under `runtime/`, cache locations, the
kernel's log messages, and how a value is formatted as output, is internal
and can change in any release.

## What 1.0 needs

1.0 means the surfaces above are stable: after it, breaking changes come
only in a new major version. Before that:

- [ ] No known bug that makes the kernel stop responding or lose a
      session's state ([#237](https://github.com/tlockney/cdp-kernel/issues/237)).
- [ ] CI runs on a schedule against the newest Node, Deno, Bun and workerd
      releases, so a runtime release that breaks the kernel is found before
      users find it ([#259](https://github.com/tlockney/cdp-kernel/issues/259)).
- [ ] A soak test covers long sessions: thousands of cells, large outputs,
      repeated interrupts, memory growth
      ([#260](https://github.com/tlockney/cdp-kernel/issues/260)).
- [ ] Several weeks of real notebook use on each target runtime and in each
      supported frontend, with no open bug that loses work.
- [ ] Every frontend in the supported list is tested in CI, or moved out
      of it.
- [ ] The command line, kernelspec names and library exports have been
      reviewed once more, and each is documented.
- [ ] A release has gone through the `release` workflow end to end.
- [ ] Contributor and security policies are published
      ([#262](https://github.com/tlockney/cdp-kernel/issues/262)).

Windows support isn't required for 1.0; it can come in a later minor
release.

## Getting help

[Troubleshooting](troubleshooting.md) covers the common problems, and
[Known gaps](known-gaps.md) lists what isn't supported yet. Report bugs and
ask for features in
[GitHub issues](https://github.com/tlockney/cdp-kernel/issues).
