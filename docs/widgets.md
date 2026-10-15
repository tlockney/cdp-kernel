# Widgets and comms

`deno jupyter` has no comms. Here they're supported in both directions, so
anywidget-style widgets work in frontends with the `anywidget` extension:
JupyterLab, Notebook 7 and VS Code. Install it with
`pip install anywidget`; that's the frontend half, no Python kernel needed.

```ts
const counter = jupyter.widget({
  esm: `export default {
    render({ model, el }) {
      const btn = document.createElement("button");
      const update = () => { btn.textContent = \`count is \${model.get("count")}\`; };
      btn.onclick = () => { model.set("count", model.get("count") + 1); model.save_changes(); };
      model.on("change:count", update);
      update();
      el.append(btn);
    },
  };`,
  state: { count: 0 },
});
counter.on("change:count", (value) => console.log("clicked to", value));
counter; // display it
```

The model API:

- `get(key)`, and `set(key, value)` or `set({ ... })`, which syncs to every
  view.
- `on("change:key" | "change" | "msg:custom", listener)` and `off(...)`.
- `send(content, buffers)` for custom messages.
- `close()`.

`Uint8Array`, `ArrayBuffer` and `DataView` values in the state travel as
binary buffers. JupyterLab restores widget state after a page reload over
the `jupyter.widget.control` comm.

The comm layer underneath is available directly, for other comm-based
protocols:

```ts
const comm = jupyter.comm.open("my.target", { hello: 1 });
comm.onMsg(({ data, buffers }) => console.log(data, buffers.length));
comm.send({ ping: true });
jupyter.comm.registerTarget("echo", (comm) => comm.onMsg((m) => comm.send(m.data)));
```

Comm handlers run like cells. Their output goes to the notebook as replies
to the message that triggered them, an exception is shown on stderr, and
interrupt stops a stuck handler. Messages are processed one at a time with
cell executions, as in ipykernel, so a widget event that arrives during a
long cell waits for the cell to finish.
