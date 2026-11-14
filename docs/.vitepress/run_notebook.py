"""Runs one docs notebook in place, for run-notebooks.ts.

    uv run --with nbclient --with nbformat python docs/.vitepress/run_notebook.py NOTEBOOK

nbclient saves the state of the widgets the notebook creates in its
metadata, so the site can run them (theme/widgets.ts). The kernel is
cdp-node as installed from this checkout into a temporary
JUPYTER_DATA_DIR, so the output is this checkout's and the user's own
kernels are left alone. The notebook's directory is its working directory.
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

import nbformat
from nbclient import NotebookClient

ROOT = Path(__file__).resolve().parents[2]


def main():
    path = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory() as data_dir:
        os.environ["JUPYTER_DATA_DIR"] = data_dir
        subprocess.run(["node", str(ROOT / "src/main.ts"), "install", "--runtime", "node"], check=True,
                       stdout=subprocess.DEVNULL)
        nb = nbformat.read(path, as_version=4)
        client = NotebookClient(nb, kernel_name="cdp-node", timeout=180, store_widget_state=True,
                                resources={"metadata": {"path": str(path.parent)}})
        client.execute()
        nbformat.write(nb, path)


if __name__ == "__main__":
    main()
