# cdp-kernel

A Jupyter kernel for TypeScript and JavaScript, extracted from Deno's
(`deno jupyter`, v2.9.6), that runs notebooks on several JavaScript runtimes. The kernel
host runs on Node or Deno; the code you type runs in a separate **target**
runtime: Node or Deno over the Chrome DevTools Protocol, or Bun, workerd and
celld, which evaluate cells in-process. In principle, anything else whose
inspector speaks CDP works too.

**Website:** <https://tlockney.github.io/cdp-kernel/> ·
**Docs:** [`docs/`](https://github.com/tlockney/cdp-kernel/tree/main/docs)

This is early software. It passes a conformance suite derived from Deno's
own Jupyter integration tests on every target, and it's packaged for npm and
JSR as `@tlockney/cdp-kernel`, but it hasn't seen much real use yet.

## Features

- The `Deno.jupyter` display API (`jupyter.display`, `md`, `html`, `svg`,
  `image`, …) on every target.
- TypeScript, TSX, top-level `await`, and `npm:`/`jsr:` imports, with an
  optional lockfile.
- Deno projects (`deno.json` import maps, JSX settings) and Workers
  projects (`wrangler` bindings in `env`).
- JupyterLab's visual debugger on Node and Deno targets.
- anywidget-style widgets and Jupyter comms.
- `prompt()` and `confirm()`, interrupt that keeps state, Shift-Tab
  inspection, completion and history.

## Install

Node 24+ host, from npm:

```sh
npm install -g @tlockney/cdp-kernel
cdp-kernel install --runtime node   # or deno, bun, workerd, celld
```

Deno host, from JSR:

```sh
deno run -A jsr:@tlockney/cdp-kernel/cli install --runtime deno
```

Each install writes a Jupyter kernelspec (`cdp-node`, `cdp-deno`, …). Pick
it in JupyterLab or VS Code. Linux and macOS are supported; Windows isn't
yet. See [Install](https://github.com/tlockney/cdp-kernel/blob/main/docs/install.md)
for `--deno-compat`, release-day installs on Deno, target runtime
requirements, and installing from a checkout.

## Quick start

```ts
import { format } from "npm:date-fns@4";

const now: Date = new Date();
await jupyter.display(jupyter.md`**Today** is ${format(now, "PPPP")}`);
```

## Documentation

- [Writing notebooks](https://github.com/tlockney/cdp-kernel/blob/main/docs/notebooks.md)
- [Runtimes: Bun, workerd, celld](https://github.com/tlockney/cdp-kernel/blob/main/docs/runtimes.md)
- [Debugger](https://github.com/tlockney/cdp-kernel/blob/main/docs/debugger.md)
- [Widgets and comms](https://github.com/tlockney/cdp-kernel/blob/main/docs/widgets.md)
- [Editor types](https://github.com/tlockney/cdp-kernel/blob/main/docs/editor-types.md)
- [Known gaps](https://github.com/tlockney/cdp-kernel/blob/main/docs/known-gaps.md)
- [Architecture](https://github.com/tlockney/cdp-kernel/blob/main/docs/architecture.md)
- [Development: tests and releasing](https://github.com/tlockney/cdp-kernel/blob/main/docs/development.md)

The [feasibility study](https://tlockney.github.io/cdp-kernel/study.html)
behind the project covers the design, the alternatives considered (workerd,
Bun, rusty_v8, FFI), and the evidence.

## License

MIT. Parts are ports of Deno's Jupyter kernel, Copyright 2018-2026 the Deno
authors; see [Architecture › Provenance](https://github.com/tlockney/cdp-kernel/blob/main/docs/architecture.md#provenance).
