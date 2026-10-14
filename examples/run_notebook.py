"""Executes examples/deno-style.ipynb on each kernel variant and saves the
executed copies next to it (deno-style.<variant>.ipynb).

    uv run --with nbclient --with nbformat python examples/run_notebook.py [deno] [node-deno]

Kernelspecs are installed into a temporary JUPYTER_DATA_DIR, so the user's
own kernels are left alone.
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

import nbformat
from nbclient import NotebookClient

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def main():
    variants = sys.argv[1:] or ["deno", "node-deno"]
    source = nbformat.read(HERE / "deno-style.ipynb", as_version=4)
    with tempfile.TemporaryDirectory() as data_dir:
        os.environ["JUPYTER_DATA_DIR"] = data_dir
        for variant in variants:
            base, _, compat = variant.partition("-")
            subprocess.run(
                ["node", str(ROOT / "src/main.ts"), "install", "--runtime", base] + (["--deno-compat"] if compat else []),
                check=True, stdout=subprocess.DEVNULL,
            )
            nb = nbformat.from_dict(source)
            name = f"cdp-{variant}"
            nb.metadata["kernelspec"] = {"name": name, "display_name": name, "language": "typescript"}
            NotebookClient(nb, kernel_name=name, timeout=300, resources={"metadata": {"path": tempfile.mkdtemp()}}).execute()
            out = HERE / f"deno-style.{variant}.ipynb"
            nbformat.write(nb, out)
            print(f"== {variant}: executed {len(nb.cells)} cells -> {out.name}")
            for i, cell in enumerate(nb.cells):
                if cell.cell_type != "code":
                    continue
                summary = []
                for output in cell.outputs:
                    if output.output_type == "stream":
                        summary.append(f"stream:{output.text.strip()[:30]!r}")
                    elif output.output_type == "error":
                        summary.append(f"ERROR {output.ename}: {output.evalue[:80]}")
                    else:
                        summary.append(f"{output.output_type}[{', '.join(output.get('data', {}))}]")
                print(f"  cell {i}: {'; '.join(summary) or '(no output)'}")


if __name__ == "__main__":
    main()
