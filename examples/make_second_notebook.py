"""Builds examples/second-notebook.ipynb: fetch JSON, reshape it, chart it,
summarize it. The step after getting-started, before the MoMA notebook.

    uv run --with nbformat python examples/make_second_notebook.py
    uv run --with nbclient --with nbformat python examples/run_notebook.py --nb second-notebook node

The second command runs it on cdp-node and saves second-notebook.node.ipynb,
the copy the docs show. Both fetch from the npm registry's public API.
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
DOCS = "https://cdp-kernel.org/docs"

nb = nbf.v4.new_notebook(metadata={
    "kernelspec": {
        "display_name": "TypeScript (cdp-kernel, node)",
        "language": "typescript",
        "name": "cdp-node",
    },
    "language_info": {"name": "typescript"},
})

md = nbf.v4.new_markdown_cell
code = nbf.v4.new_code_cell

nb.cells = [
    md(
        "# Express's release history\n"
        "\n"
        "A short notebook in the shape a lot of data work takes: fetch some JSON,\n"
        "reshape it, draw a chart, write a summary. The data is every release of\n"
        "[Express](https://expressjs.com), from the npm registry's public API, which\n"
        "needs no key. The only package it imports is `vega-lite-api`, for the chart.\n"
        "\n"
        f"If this is your first notebook, start with [Getting started]({DOCS}/getting-started)."
    ),
    md("## Fetch"),
    code(
        'const pkg = await (await fetch("https://registry.npmjs.org/express")).json();\n'
        '({ name: pkg.name, description: pkg.description, distTags: pkg["dist-tags"] })'
    ),
    md(
        "The response is the package's whole registry record: metadata for every\n"
        "version under `versions`, and when each was published under `time`. It stays\n"
        "in `pkg`, so the cells below don't fetch it again."
    ),
    md(
        "## Reshape\n"
        "\n"
        "One row per published version. `time` also lists versions that were later\n"
        "unpublished, so the rows come from `versions`. A version is a prerelease if\n"
        "it has anything after `major.minor.patch`, as in `5.0.0-beta.1` or the older\n"
        "`1.0.0rc4`."
    ),
    code(
        "type Release = { version: string; line: string; prerelease: boolean; date: Date };\n"
        "\n"
        "const releases: Release[] = Object.keys(pkg.versions)\n"
        "  .map((version) => ({\n"
        "    version,\n"
        '    line: version.split(".")[0] + ".x",\n'
        "    prerelease: !/^\\d+\\.\\d+\\.\\d+$/.test(version),\n"
        "    date: new Date(pkg.time[version]),\n"
        "  }))\n"
        "  // By date, then by version for releases published at the same moment.\n"
        "  .toSorted((a, b) => a.date.getTime() - b.date.getTime()\n"
        "    || a.version.localeCompare(b.version, \"en\", { numeric: true }));\n"
        "\n"
        'console.log(releases.length, "releases,", releases.filter((r) => r.prerelease).length, "of them prereleases");\n'
        "releases.slice(-5)"
    ),
    md(
        "## Chart\n"
        "\n"
        "Stable releases per year, colored by major version. Prereleases are left\n"
        "out: the old ones for 1.x to 3.x all share one timestamp from August 2013,\n"
        "so their dates say little.\n"
        "\n"
        "`vega-lite-api` builds a Vega-Lite chart in code, and the kernel shows any\n"
        "object with a `toSpec()` method as a chart, so the cell's last expression is\n"
        "all it takes. Vega-Lite does the counting: `year(\"date\")` groups the rows\n"
        "by year and `count()` counts each group."
    ),
    code(
        'import * as vl from "npm:vega-lite-api@5";\n'
        "\n"
        "vl.markBar()\n"
        "  .data(releases.filter((r) => !r.prerelease))\n"
        "  .encode(\n"
        '    vl.x().year("date").title(null),\n'
        '    vl.y().count().title("releases"),\n'
        '    vl.color().fieldN("line").title("version"),\n'
        '    vl.tooltip([vl.year("date"), vl.fieldN("line"), vl.count()]),\n'
        "  )\n"
        "  .width(460)\n"
        "  .height(220)"
    ),
    md(
        "## Downloads\n"
        "\n"
        "Which of those versions are people installing? A second endpoint returns\n"
        "last week's downloads per version. The cell shows a placeholder while it\n"
        "fetches, then replaces it with the result: displaying again with the same\n"
        "`display_id` and `update: true` updates the output in place instead of\n"
        "adding another."
    ),
    code(
        'await jupyter.display(jupyter.md`Fetching last week\'s downloads...`, { display_id: "downloads" });\n'
        "\n"
        "const { downloads }: { downloads: Record<string, number> } =\n"
        '  await (await fetch("https://api.npmjs.org/versions/express/last-week")).json();\n'
        "const total = Object.values(downloads).reduce((sum, n) => sum + n, 0);\n"
        "\n"
        "await jupyter.display(\n"
        "  jupyter.md`**${total.toLocaleString()}** downloads last week, across ${Object.keys(downloads).length} versions.`,\n"
        '  { display_id: "downloads", update: true },\n'
        ");"
    ),
    md(
        "## Summary\n"
        "\n"
        "One row per major version, built as a Markdown table and rendered with\n"
        "`jupyter.md`. The downloads share counts every version in the line,\n"
        "prereleases included."
    ),
    code(
        "const byLine = Object.groupBy(releases, (r) => r.line);\n"
        "\n"
        "const rows = Object.entries(byLine).map(([line, list]) => {\n"
        "  const stable = list!.filter((r) => !r.prerelease);\n"
        "  const latest = stable.at(-1)!;\n"
        "  const weekly = list!.reduce((sum, r) => sum + (downloads[r.version] ?? 0), 0);\n"
        "  return `| ${line} | ${stable.length} | ${list!.length - stable.length} | ${stable[0].date.getUTCFullYear()} | `\n"
        "    + `${latest.version} (${latest.date.toISOString().slice(0, 10)}) | ${(100 * weekly / total).toFixed(1)}% |`;\n"
        "});\n"
        "\n"
        "jupyter.md`| Line | Releases | Prereleases | First release | Latest release | Share of last week's downloads |\n"
        "| --- | ---: | ---: | ---: | --- | ---: |\n"
        "${rows.join(\"\\n\")}`"
    ),
    md(
        "## Next\n"
        "\n"
        "- Swap `express` for another package, or the registry for another JSON API.\n"
        f"- [The jupyter namespace]({DOCS}/jupyter-api) covers `jupyter.display`,\n"
        "  `jupyter.md` and the other ways to show output.\n"
        f"- [MoMA's collection]({DOCS}/example-moma) is a longer notebook: a\n"
        "  160,000-row dataset with Polars, Observable Plot, a widget and React."
    ),
]

nbf.write(nb, HERE / "second-notebook.ipynb")
print(f"wrote {HERE / 'second-notebook.ipynb'}")
