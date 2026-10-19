# cdp-kernel

A Jupyter kernel for TypeScript and JavaScript, extracted from the one built
into Deno 2.9.6 (`deno jupyter`), that runs notebooks on several JavaScript runtimes. The kernel
host runs on Node or Deno; the code you type runs in a separate **target**
runtime: Node or Deno over the Chrome DevTools Protocol, or Bun, workerd and
celld, which evaluate cells in-process. In principle, anything else whose
inspector speaks CDP works too. The kernel can also run inside a web page,
with cells in a Web Worker and no server
([The browser](https://cdp-kernel.org/docs/integration-browser), experimental).

**Website:** <https://cdp-kernel.org/> ·
**Docs:** [cdp-kernel.org/docs](https://cdp-kernel.org/docs/)

[![Try it on Binder](https://mybinder.org/badge_logo.svg)](https://mybinder.org/v2/gh/tlockney/cdp-kernel/main?urlpath=lab/tree/getting-started.ipynb)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/tlockney/cdp-kernel?quickstart=1)

Binder opens JupyterLab with every runtime and the example notebooks,
nothing installed. A Codespace does the same in VS Code, with the
repository checked out ([Install › In a container](https://cdp-kernel.org/docs/install#in-a-container)).

This is early software. It passes a conformance suite derived from Deno's
own Jupyter integration tests on every target, and it's packaged for npm and
JSR as `@tlockney/cdp-kernel`, but it hasn't seen much real use yet.
The [support policy](https://cdp-kernel.org/docs/support) says which
runtime versions and frontends are supported, and what may change before
1.0.

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

Node 22.18+ host, from npm:

```sh
npm install -g @tlockney/cdp-kernel
cdp-kernel install --runtime node   # or deno, bun, workerd, celld
```

Deno host, from JSR:

```sh
deno run -A jsr:@tlockney/cdp-kernel/cli install --runtime deno
```

Each install writes a Jupyter kernelspec (`cdp-node`, `cdp-deno`, …). Pick
it in JupyterLab or VS Code. To run notebooks with no Python installed,
serve JupyterLab with
[Ganymede](https://ganymede-server.com/docs/install). Linux and macOS
are supported; Windows isn't yet. See
[Install](https://cdp-kernel.org/docs/install) for `--deno-compat`, release-day installs on Deno, target runtime
requirements, and installing from a checkout.

JupyterLab with every runtime and the examples, in a container:

```sh
docker run --rm -p 8888:8888 ghcr.io/tlockney/cdp-kernel
```

## Quick start

```ts
import { format } from "npm:date-fns@4";

const now: Date = new Date();
await jupyter.display(jupyter.md`**Today** is ${format(now, "PPPP")}`);
```

## Documentation

New to Jupyter? Start with
[Getting started](https://cdp-kernel.org/docs/getting-started).

- Guides: [Writing notebooks](https://cdp-kernel.org/docs/notebooks),
  [The `jupyter` namespace](https://cdp-kernel.org/docs/jupyter-api),
  [Choosing a runtime](https://cdp-kernel.org/docs/runtimes),
  [Widgets and comms](https://cdp-kernel.org/docs/widgets),
  [Debugger](https://cdp-kernel.org/docs/debugger)
- Reference: [Editor types](https://cdp-kernel.org/docs/editor-types),
  [Known gaps](https://cdp-kernel.org/docs/known-gaps),
  [Support policy](https://cdp-kernel.org/docs/support)
- Internals: [Architecture](https://cdp-kernel.org/docs/architecture),
  [Runtime integrations](https://cdp-kernel.org/docs/integrations)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md),
  [Development](https://cdp-kernel.org/docs/development),
  [Security policy](SECURITY.md)

The [feasibility study](https://cdp-kernel.org/docs/feasibility-study)
behind the project covers the design, the alternatives considered (workerd,
Bun, rusty_v8, FFI), and the evidence.

## License

MIT. Parts are ports of Deno's Jupyter kernel, Copyright 2018-2026 the Deno
authors. The debugger's MurmurHash2 follows JupyterLab's (BSD-3-Clause) and
Gary Court's (MIT); their notices are in
[THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES). See
[Architecture › Provenance](https://cdp-kernel.org/docs/architecture#provenance).
