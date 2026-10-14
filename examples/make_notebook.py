"""Builds examples/deno-style.ipynb: a notebook written for `deno jupyter`.

    uv run --with nbformat python examples/make_notebook.py
"""

from pathlib import Path

import nbformat
from nbformat.v4 import new_code_cell, new_markdown_cell, new_notebook

cells = [
    new_markdown_cell(
        "# A Deno-style notebook\n\n"
        "Written against `deno jupyter`'s APIs. Executed by cdp-kernel on a Deno target and on a "
        "Node target with the Deno compatibility shim."
    ),
    new_code_cell(
        "// The compat shim reports a placeholder Deno version.\n"
        'const runtime = Deno.version.deno.includes("cdp-kernel")\n'
        "  ? `Node ${process.versions.node} (Deno compat shim)` : `Deno ${Deno.version.deno}`;\n"
        "Deno.jupyter.md`Running on **${runtime}**, V8 ${Deno.version.v8}`"
    ),
    new_code_cell(
        'import pl from "npm:nodejs-polars@0.18.0";\n\n'
        "const df = pl.DataFrame({\n"
        '  fruit: ["apple", "banana", "cherry", "durian"],\n'
        "  count: [3, 5, 8, 1],\n"
        "  price: [0.5, 0.25, 3.0, 9.75],\n"
        "});\n"
        "df"
    ),
    new_code_cell('df.filter(pl.col("count").gt(2)).withColumn(pl.col("price").mul(pl.col("count")).alias("total"))'),
    new_code_cell(
        "interface Point { x: number; y: number }\n"
        "const points: Point[] = Array.from({ length: 12 }, (_, i) => ({ x: i, y: Math.round(10 * Math.sin(i / 2)) }));\n"
        "const chart = {\n"
        "  toSpec: () => ({\n"
        '    $schema: "https://vega.github.io/schema/vega-lite/v5.json",\n'
        "    data: { values: points },\n"
        '    mark: "line",\n'
        '    encoding: { x: { field: "x", type: "quantitative" }, y: { field: "y", type: "quantitative" } },\n'
        "  }),\n"
        "};\n"
        "chart"
    ),
    new_code_cell(
        "Deno.jupyter.svg`<svg width=\"120\" height=\"40\" xmlns=\"http://www.w3.org/2000/svg\">\n"
        '  <rect width="120" height="40" rx="6" fill="#2f5d50"/>\n'
        '  <text x="60" y="26" fill="#f4efe3" font-family="sans-serif" font-size="16" text-anchor="middle">cdp-kernel</text>\n'
        "</svg>`"
    ),
    new_code_cell(
        'await Deno.jupyter.display(Deno.jupyter.html`<progress value="0" max="3"></progress>`, { display_id: "progress" });\n'
        "for (let i = 1; i <= 3; i++) {\n"
        "  await new Promise((r) => setTimeout(r, 50));\n"
        '  await Deno.jupyter.display(Deno.jupyter.html`<progress value="${i}" max="3"></progress> step ${i}`, { display_id: "progress", update: true });\n'
        "}\n"
        'console.log("done");'
    ),
    new_code_cell(
        "class Badge {\n"
        "  constructor(readonly label: string) {}\n"
        '  [Symbol.for("Jupyter.display")]() {\n'
        '    return { "text/html": `<span style="padding:2px 8px;border-radius:9px;background:#b08d57;color:#fff">${this.label}</span>` };\n'
        "  }\n"
        "}\n"
        'new Badge("custom display")'
    ),
    new_code_cell(
        'const dir = await Deno.makeTempDir({ prefix: "nb-" });\n'
        'await Deno.writeTextFile(`${dir}/hello.txt`, "hello from a notebook\\n");\n'
        "const names = [];\n"
        "for await (const entry of Deno.readDir(dir)) names.push(entry.name);\n"
        "({ names, text: await Deno.readTextFile(`${dir}/hello.txt`) })"
    ),
]

nb = new_notebook(cells=cells)
nb.metadata["kernelspec"] = {"name": "cdp-deno", "display_name": "TypeScript (cdp-kernel, deno)", "language": "typescript"}
nb.metadata["language_info"] = {"name": "typescript", "file_extension": ".ts"}
out = Path(__file__).with_name("deno-style.ipynb")
nbformat.write(nb, out)
print(f"wrote {out}")
