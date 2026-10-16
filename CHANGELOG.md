# Changelog

What changed in each release of `@tlockney/cdp-kernel` (npm and JSR).
Issue and pull request numbers refer to
[tlockney/cdp-kernel](https://github.com/tlockney/cdp-kernel).

## Unreleased

- On Node, `.ts`, `.tsx` and `.jsx` files imported by a cell are compiled
  with esbuild when Node's type stripping can't handle them (enums,
  namespaces, parameter properties, JSX)
  ([#73](https://github.com/tlockney/cdp-kernel/issues/73),
  [#91](https://github.com/tlockney/cdp-kernel/issues/91)).
- Fewer startup failures: a runtime whose start fails or stalls is stopped
  ([#52](https://github.com/tlockney/cdp-kernel/issues/52)); intermittent
  "Promise was collected" errors are fixed
  ([#50](https://github.com/tlockney/cdp-kernel/issues/50),
  [#55](https://github.com/tlockney/cdp-kernel/issues/55)); celld retries a
  start that loses a port race; a kernel port briefly in use at startup is
  retried.
- npm installs run through `cmd.exe` on Windows
  ([#51](https://github.com/tlockney/cdp-kernel/issues/51)). Windows is
  still not supported.
- Documentation site at [cdp-kernel.org/docs](https://cdp-kernel.org/docs/).

## 0.4.0 (2026-10-15)

- JupyterLab's visual debugger on Node and Deno: breakpoints, stepping,
  variables and pause on exceptions, over CDP
  ([#18](https://github.com/tlockney/cdp-kernel/issues/18)).
- Inspection tooltips (Shift+Tab) and input history
  ([#10](https://github.com/tlockney/cdp-kernel/issues/10)).
- An opt-in `cdp-kernel.lock.json` pins `npm:`/`jsr:` versions per
  notebook, and installs are serialized
  ([#14](https://github.com/tlockney/cdp-kernel/issues/14)).
- `npm:` installs save exact versions, so a range stays at what it first
  resolved to, and `jsr:` works with npm 12
  ([#39](https://github.com/tlockney/cdp-kernel/issues/39),
  [#40](https://github.com/tlockney/cdp-kernel/issues/40)). Caches written
  by 0.3.0 or earlier can be deleted to start fresh.
- JSR kernelspecs start on release day despite Deno's minimum dependency
  age ([#12](https://github.com/tlockney/cdp-kernel/issues/12)).
- CI covers Node 24 and 26 with Deno 2.9 and the latest 2.x, on Linux and
  macOS ([#15](https://github.com/tlockney/cdp-kernel/issues/15)).
- A MoMA collection example notebook.

## 0.3.0 (2026-10-14)

- New targets: Bun ([#7](https://github.com/tlockney/cdp-kernel/issues/7)),
  workerd ([#8](https://github.com/tlockney/cdp-kernel/issues/8)) and celld
  ([#25](https://github.com/tlockney/cdp-kernel/issues/25)).
- In a Workers project, cells get the project's bindings as `env`
  ([#26](https://github.com/tlockney/cdp-kernel/issues/26)).

## 0.2.0 (2026-10-14)

- Jupyter comms and anywidget-style widgets with `jupyter.widget`
  ([#9](https://github.com/tlockney/cdp-kernel/issues/9)).
- Deno targets honour the notebook's Deno project config
  ([#13](https://github.com/tlockney/cdp-kernel/issues/13)).
- Type declarations for the `jupyter` global
  ([#11](https://github.com/tlockney/cdp-kernel/issues/11)).
- `kernel_info` reports the real version, and the inspector's URL is kept
  private ([#22](https://github.com/tlockney/cdp-kernel/issues/22)).

## 0.1.1 (2026-10-14)

First release on npm and JSR. A Jupyter kernel ported from `deno jupyter`
(v2.9.6) that runs cells on Node or Deno over the Chrome DevTools Protocol:
the `jupyter` display API, TypeScript, `npm:` and `jsr:` imports,
interrupt, `prompt()`/`confirm()`, and an opt-in `Deno` namespace for Node.
