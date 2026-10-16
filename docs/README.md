# cdp-kernel documentation

- [Install](install.md): npm, JSR, or a checkout; what each target runtime needs.
- [Writing notebooks](notebooks.md): display API, imports, `npm:`/`jsr:`, the lockfile, Deno projects, input, inspection.
- [Runtimes](runtimes.md): how the Bun, workerd and celld targets work, and Workers projects.
- [Debugger](debugger.md): JupyterLab's visual debugger on Node and Deno targets.
- [Widgets and comms](widgets.md): anywidget-style widgets and the comm API.
- [Editor types](editor-types.md): type declarations for the notebook globals.
- [Known gaps](known-gaps.md): what doesn't work yet, per runtime.
- [Architecture](architecture.md): how the kernel was extracted from Deno, and how the tricky parts work.
- [Runtime integrations](integrations.md): how the kernel drives each runtime, with diagrams: [Node and Deno](integration-cdp.md), [Bun](integration-bun.md), [workerd and celld](integration-workers.md).
- [Development](development.md): tests and releasing.

The [feasibility study](life-after-deno-jupyter.html) behind the project
covers the design, the other options considered, and the evidence. It was
written while the project was a spike and revised after 0.4.0; its last
section compares what it predicted with what was built.
