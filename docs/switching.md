# Switching to cdp-kernel

This page is for people who already write notebooks with another kernel:
`deno jupyter`, tslab or IJavascript, or Python. Each section says what
carries over, what changes, and where the details are.

## From `deno jupyter`

cdp-kernel is a port of `deno jupyter`'s kernel, so most of a Deno
notebook carries over. Deno's runtime is on a 2.9.x LTS line, with
bug-fix and security releases until October 2027 and no new features
([What changed](feasibility-study.md#what-changed)). cdp-kernel can keep
running the same notebooks on Deno, and on Node when you want to move off
Deno.

Two kernels run a Deno notebook:

- **`cdp-deno`** runs cells on Deno itself. `Deno.jupyter` and every other
  `Deno.*` API are Deno's own, and a `deno.json` at or above the notebook
  is used as `deno jupyter` uses it.
- **`cdp-node-deno`** runs cells on Node with a partial `Deno` namespace:
  `Deno.jupyter`, `Deno.env`, and Deno's basic file and process functions.
  Use it to move a notebook to Node without rewriting it.

```sh
cdp-kernel install --runtime deno
cdp-kernel install --runtime node --deno-compat
```

Open the notebook and pick one of them with **Kernel › Change Kernel**.
[Install](install.md) covers the JSR route, which needs no Node.

What stays the same:

- The display API. `Deno.jupyter` and the `jupyter` global are the same
  object on both kernels, with `display`, `md`, `html`, `svg`, `image`,
  `format`, `broadcast` and the `$display` symbol.
- Rich values: Polars DataFrames, Vega-Lite charts, canvases, images and
  DOM elements display as they do in Deno.
- The language: TypeScript, TSX, top-level `await`, `const`
  redeclaration across cells, `npm:` and `jsr:` imports. Cells aren't
  type-checked, as in Deno.
- The notebook file. [A Deno-style notebook](example-deno-style.md) is
  written against `deno jupyter`'s APIs and gives the same outputs on
  `cdp-deno` and `cdp-node-deno`.

What changes:

- **Lockfiles.** `cdp-deno` runs Deno with `--no-lock`, so it neither
  reads nor writes a project's `deno.lock`. Pin a version with an exact
  specifier (`npm:nodejs-polars@0.18.0`). On Node, a
  `cdp-kernel.lock.json` next to the notebook pins every `npm:` and `jsr:`
  import ([Lockfile](notebooks.md#lockfile)).
- **The `Deno` namespace on Node is partial.** `Deno.serve`,
  `Deno.Command`, `Deno.open`, `Deno.openKv` and other members outside the
  shim are `undefined`, and `Deno.version.deno` is `"0.0.0-cdp-kernel"`.
  [Notebooks written for Deno](jupyter-api.md#notebooks-written-for-deno)
  lists what's there.
- **Formatting.** On Node, results are formatted by `util.inspect`, so
  strings are quoted `'…'` rather than `"…"`
  ([Known gaps](known-gaps.md)).
- **WebGPU** textures and buffers don't display.

What you gain: [widgets](widgets.md) (`deno jupyter` has none),
JupyterLab's [debugger](debugger.md) on Node and Deno, and the other
[runtimes](runtimes.md). New notebooks should use `jupyter` rather than
`Deno.jupyter`, so they run on every kernel.

## From tslab or IJavascript

tslab and IJavascript are the older Node kernels. According to the
[feasibility study](feasibility-study.md#what-changed), tslab's last
release was in mid-2024 and IJavascript's in 2021, and both depend on the
native `zeromq` addon. cdp-kernel speaks Jupyter's ZeroMQ protocol in
plain JavaScript, so it has no native addon to build.

Install the Node kernel and pick `cdp-node` with **Kernel › Change
Kernel**:

```sh
npm install -g @tlockney/cdp-kernel
cdp-kernel install --runtime node
```

What cdp-kernel adds:

- `npm:` and `jsr:` imports that install on first use, with an optional
  lockfile ([Language and imports](notebooks.md#language-and-imports)).
- TypeScript and TSX through esbuild, with no `tsconfig.json`.
- Rich output through the [`jupyter` namespace](jupyter-api.md), the same
  API as `deno jupyter`. Code that called a kernel-specific display
  helper needs to call `jupyter.display` or `jupyter.html` instead.
- Interactive [widgets](widgets.md), JupyterLab's
  [debugger](debugger.md), typed completion and inspection
  ([Inspection, completion and history](notebooks.md#inspection-completion-and-history)),
  and, on Node, an interrupt that keeps your variables.
- The same notebook on Deno, Bun, workerd and celld
  ([Choosing a runtime](runtimes.md)).

One behavior may differ from what you're used to. On Node and Deno, cells
run as `deno jupyter` runs them: a top-level `const` stays constant, and
any final expression is the cell's result. The Bun, workerd and celld
targets instead hoist declarations onto `globalThis`, the technique tslab
and IJavascript use ([Bun](integration-bun.md#running-a-cell-without-replmode)).

## From Python

The notebook works the same way: cells, outputs, **Kernel › Interrupt**
and **Kernel › Restart**. The libraries differ. Each line below is a
starting point, not a drop-in replacement.

| In Python | In cdp-kernel | Where to read |
| --- | --- | --- |
| pandas | `npm:nodejs-polars` DataFrames display as tables; `npm:arquero` is another option | [Tables with Polars](jupyter-api.md#values-shown-richly-without-any-code), [MoMA's collection](example-moma.md) |
| matplotlib, seaborn | Observable Plot (`npm:@observablehq/plot`, with linkedom as its DOM on Node), Vega-Lite (`npm:vega-lite-api`), or a canvas (`npm:@napi-rs/canvas`) | [Charts with Vega-Lite](jupyter-api.md#values-shown-richly-without-any-code), [MoMA's collection](example-moma.md) |
| `IPython.display.display`, `HTML`, `Markdown`, `SVG` | `jupyter.display`, and the `jupyter.html`, `jupyter.md`, `jupyter.svg` tags | [The `jupyter` namespace](jupyter-api.md) |
| `display(..., display_id=...)` and `update_display` | `jupyter.display(value, { display_id, update: true })` | [Updating output in place](jupyter-api.md#updating-output-in-place) |
| `_repr_html_` on a class | a `[jupyter.$display]()` method | [Custom display](jupyter-api.md#custom-display-for-your-own-classes) |
| `input()` | `prompt()` and `confirm()` | [Asking for input](jupyter-api.md#asking-for-input-prompt-and-confirm) |
| ipywidgets | `jupyter.widget`, [anywidget](https://github.com/manzt/anywidget)-style. The ready-made controls (`IntSlider`, `Dropdown`) are Python classes and aren't available; you build controls from HTML | [Widgets and comms](widgets.md) |
| `pip install` | `import pl from "npm:nodejs-polars@0.18"` installs on first use | [Language and imports](notebooks.md#language-and-imports) |

Widgets still need `pip install anywidget` in the Python environment that
runs JupyterLab, for the frontend; no Python kernel is involved
([Before you start](widgets.md#before-you-start)).

Packages with native add-ons, such as nodejs-polars and @napi-rs/canvas,
work on Node, Deno and Bun but not on workerd or celld.
