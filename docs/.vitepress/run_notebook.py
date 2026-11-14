"""Runs one docs notebook in place, for run-notebooks.ts.

    uv run --with nbclient --with nbformat python docs/.vitepress/run_notebook.py NOTEBOOK

nbclient saves the state of the widgets the notebook creates in its
metadata. On top of that, each widget output gets the state its model had
once the output's own cell ran, in the output's metadata under `docs`, so
the site (notebook.ts, theme/widgets.ts) shows an earlier output as it was
before a later cell changed the model.

A cell's `docs.view_sends` metadata (from a <!-- view sends for ... -->
comment on the page) lists comm messages to send as the view of the
cell's widget, as a click or a slider would, once the cell has run. The
kernel's replies are saved: its state changes in the snapshot, and the
custom messages it sends the views, which the page replays.

The kernel is cdp-node as installed from this checkout into a temporary
JUPYTER_DATA_DIR, so the output is this checkout's and the user's own
kernels are left alone. The notebook's directory is its working directory.
"""

import asyncio
import copy
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import nbformat
from nbclient import NotebookClient

ROOT = Path(__file__).resolve().parents[2]
VIEW = "application/vnd.jupyter.widget-view+json"
# State keys a model never changes, left out of the per-output snapshots.
FIXED = {"_esm", "_css", "_anywidget_id", "_model_name", "_model_module", "_model_module_version",
         "_view_name", "_view_module", "_view_module_version"}


class DocsClient(NotebookClient):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Custom messages the kernel sent each model's views during the
        # current cell, by model id.
        self.custom = {}

    def handle_comm_msg(self, outs, msg, cell_index):
        super().handle_comm_msg(outs, msg, cell_index)
        data = msg["content"].get("data") or {}
        if msg["msg_type"] == "comm_msg" and data.get("method") == "custom":
            self.custom.setdefault(msg["content"]["comm_id"], []).append({"content": data.get("content")})

    async def async_execute_cell(self, cell, cell_index, execution_count=None, store_history=True):
        self.custom = {}
        cell = await super().async_execute_cell(cell, cell_index, execution_count, store_history)
        if cell.cell_type != "code":
            return cell
        models = [o["data"][VIEW]["model_id"] for o in cell.get("outputs", []) if VIEW in o.get("data", {})]
        docs = cell.metadata.get("docs", {})
        sends = docs.get("view_sends")
        if sends:
            if not models:
                raise RuntimeError(f"cell {cell_index} scripts view messages but shows no widget")
            for data in sends:
                await self.send_as_view(models[0], data, cell_index)
        for output in cell.get("outputs", []):
            model_id = output.get("data", {}).get(VIEW, {}).get("model_id")
            if model_id not in self.widget_state:
                continue
            # The view module, stylesheet and id don't change; the page takes
            # them from the notebook's saved state.
            state = {k: v for k, v in self.widget_state[model_id].items() if k not in FIXED}
            snapshot = {"state": copy.deepcopy(state)}
            buffers = self.widget_buffers.get(model_id)
            if buffers:
                snapshot["buffers"] = copy.deepcopy(list(buffers.values()))
            if self.custom.get(model_id):
                snapshot["messages"] = self.custom[model_id]
            if sends and model_id == models[0]:
                snapshot["view_sent"] = docs["view_sent"]
            output.setdefault("metadata", {})["docs"] = snapshot
        return cell

    async def send_as_view(self, model_id, data, cell_index):
        """Sends `data` on the model's comm as its view would, and handles the
        kernel's messages in reply until it is idle again."""
        # The view's own copy of the model changes as it sends: a frontend
        # doesn't wait for the kernel to echo an update back.
        if data.get("method") == "update":
            self.widget_state.setdefault(model_id, {}).update(data.get("state", {}))
        msg = self.kc.session.msg("comm_msg", {"comm_id": model_id, "data": data})
        self.kc.shell_channel.send(msg)
        msg_id = msg["header"]["msg_id"]
        while True:
            reply = await asyncio.wait_for(self.kc.iopub_channel.get_msg(timeout=None), 60)
            # Only the replies to this message count: a late update from
            # earlier async work isn't part of this widget's snapshot.
            if reply["parent_header"].get("msg_id") != msg_id:
                continue
            kind = reply["msg_type"]
            if kind == "status" and reply["content"]["execution_state"] == "idle":
                return
            if kind in ("comm_msg", "comm_open"):
                self.handle_comm_msg([], reply, cell_index)
            elif kind == "error":
                raise RuntimeError(f"the kernel failed handling a view message: {reply['content']['evalue']}")
            elif kind == "stream" and reply["content"]["name"] == "stderr":
                # A comm listener that throws is reported as stderr, not as an error.
                raise RuntimeError(f"the kernel wrote to stderr handling a view message: {reply['content']['text']}")


def main():
    path = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory() as data_dir:
        os.environ["JUPYTER_DATA_DIR"] = data_dir
        subprocess.run(["node", str(ROOT / "src/main.ts"), "install", "--runtime", "node"], check=True,
                       stdout=subprocess.DEVNULL)
        nb = nbformat.read(path, as_version=4)
        client = DocsClient(nb, kernel_name="cdp-node", timeout=180, store_widget_state=True,
                            resources={"metadata": {"path": str(path.parent)}})
        client.execute()
        nbformat.write(nb, path)


if __name__ == "__main__":
    main()
