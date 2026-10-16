# cdp-kernel documentation

cdp-kernel lets you write TypeScript and JavaScript in Jupyter notebooks
and run them on Node, Deno, Bun, workerd or celld. These docs are grouped
by how much you already know. Each page shows its level under the title.

## New to notebooks

Start here if you haven't used Jupyter, or haven't used it with
TypeScript. No Deno background is needed.

1. [Getting started](getting-started.md): what notebooks and kernels are,
   installing, a first notebook, and what notebooks are good for.
2. [Install](install.md): every install route (npm, JSR) and what each
   target runtime needs.

## Using cdp-kernel

Guides for day-to-day use, once you've run a first notebook.

- [Writing notebooks](notebooks.md): imports, `npm:` and `jsr:` packages,
  the lockfile, Deno projects, interrupt and inspection.
- [The `jupyter` namespace](jupyter-api.md): rich output (Markdown, HTML,
  SVG, images, charts, tables), custom display, `prompt` and `confirm`,
  and running notebooks written for Deno.
- [Choosing a runtime](runtimes.md): what differs between the runtimes,
  and Workers and celld projects.
- [Widgets and comms](widgets.md): interactive anywidget-style widgets and
  the comm API.
- [Debugger](debugger.md): breakpoints and stepping in JupyterLab on Node
  and Deno.

Reference pages to look things up in:

- [Editor types](editor-types.md): stop your editor flagging `jupyter`,
  `prompt` and `confirm` as unknown names, and get completion for them.
- [Known gaps](known-gaps.md): what doesn't work yet, per runtime.
- [Troubleshooting](troubleshooting.md): a missing kernel, startup
  failures, `KernelError`, restarts, and which cache to clear.
- [Changelog](changelog.md): what changed in each release.

## How it works

Advanced material on the kernel's internals. You don't need it to use
cdp-kernel.

- [Architecture](architecture.md): how the kernel was extracted from Deno,
  and how cells become runnable code.
- [Runtime integrations](integrations.md): how the kernel drives each
  runtime, with diagrams: [Node and Deno](integration-cdp.md),
  [Bun](integration-bun.md), [workerd and celld](integration-workers.md).
- The [feasibility study](feasibility-study.md) is the design
  document the project started from. It was written while the project was
  a spike and revised after 0.4.0; its last section compares what it
  predicted with what was built.

## Contributing

- [Development](development.md): running from a checkout, tests, and
  releasing.
