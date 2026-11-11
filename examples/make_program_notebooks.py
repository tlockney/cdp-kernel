"""Builds examples/package-stats.ipynb and examples/compare-packages.ipynb:
a notebook that runs as a program (parameters in, named results out),
and a notebook that runs it for several packages through Ganymede's host
API. Both fetch from the npm registry's public API.

    uv run --with nbformat python examples/make_program_notebooks.py

Then, in examples/, with Ganymede and a cdp-node kernel installed:

    ganymede execute package-stats.ipynb -p pkg=hono -o package-stats.hono.ipynb
    ganymede execute compare-packages.ipynb --grant run=package-stats.ipynb \
        -o compare-packages.node.ipynb

The two outputs are the copies the docs show. `ganymede execute --grant`
needs a Ganymede release after 0.9.0; with 0.8.0 or 0.9.0, run compare-packages in
JupyterLab under `ganymede lab` after
`ganymede grant compare-packages.ipynb run=package-stats.ipynb`.
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent
DOCS = "https://cdp-kernel.org/docs"
GANYMEDE = "https://ganymede-server.com/docs"

md = nbf.v4.new_markdown_cell
code = nbf.v4.new_code_cell


def notebook(cells):
    nb = nbf.v4.new_notebook(metadata={
        "kernelspec": {
            "display_name": "TypeScript (cdp-kernel, node)",
            "language": "typescript",
            "name": "cdp-node",
        },
        "language_info": {"name": "typescript"},
    })
    nb.cells = cells
    return nb


stats = notebook([
    md(
        "# One package's numbers\n"
        "\n"
        "A notebook that runs like a program: it takes a package name as a\n"
        "parameter and hands back a few numbers about it as named results.\n"
        "Run on its own, it reports on `express`. With\n"
        f"[Ganymede]({GANYMEDE}/programs), a script, a Shortcut or another notebook\n"
        "runs it with a different package and reads the results by name:\n"
        "\n"
        "```sh\n"
        "ganymede execute package-stats.ipynb -p pkg=hono --results\n"
        "```"
    ),
    md(
        "## Parameters\n"
        "\n"
        "`jupyter.params` holds the run's parameters, or `{}` when there are none.\n"
        "Destructuring with a default keeps the notebook runnable by hand."
    ),
    code(
        'const { pkg = "express" } = jupyter.params as { pkg?: string };\n'
        "pkg"
    ),
    md(
        "## Fetch\n"
        "\n"
        "The package's registry record, and last week's downloads. Neither\n"
        "endpoint needs a key."
    ),
    code(
        "const record = await (await fetch(`https://registry.npmjs.org/${pkg}`)).json();\n"
        "const { downloads }: { downloads: number } =\n"
        "  await (await fetch(`https://api.npmjs.org/downloads/point/last-week/${pkg}`)).json();\n"
        "\n"
        "const stable = Object.keys(record.versions).filter((v) => /^\\d+\\.\\d+\\.\\d+$/.test(v));\n"
        'const latest: string = record["dist-tags"].latest;\n'
        "const firstRelease = record.time.created.slice(0, 10);\n"
        "const lastRelease = record.time[latest].slice(0, 10);"
    ),
    md(
        "## Results\n"
        "\n"
        "`jupyter.result(name, value)` publishes a value under a name. Each one\n"
        "shows as a `name = value` line, and whoever ran the notebook reads it\n"
        "as JSON, without parsing the output."
    ),
    code(
        'jupyter.result("package", pkg);\n'
        'jupyter.result("latest", latest);\n'
        'jupyter.result("stable_releases", stable.length);\n'
        'jupyter.result("first_release", firstRelease);\n'
        'jupyter.result("weekly_downloads", downloads);'
    ),
    md(
        "## Summary\n"
        "\n"
        "For a person reading the notebook, the same numbers as a sentence."
    ),
    code(
        "jupyter.md`**${pkg}** ${latest}, released ${lastRelease}: ${stable.length} stable releases since ${firstRelease},\n"
        "and ${downloads.toLocaleString(\"en\")} downloads last week.`"
    ),
    md(
        "## Next\n"
        "\n"
        f"- [Comparing packages]({DOCS}/example-compare-packages) runs this notebook\n"
        "  once per package from another notebook, through Ganymede's host API.\n"
        f"- [Parameters and named results]({DOCS}/jupyter-api#parameters-and-named-results)\n"
        "  has the details of `jupyter.params` and `jupyter.result`."
    ),
])

compare = notebook([
    md(
        "# Comparing packages\n"
        "\n"
        "This notebook runs another notebook,\n"
        f"[One package's numbers]({DOCS}/example-package-stats)\n"
        "(`package-stats.ipynb`), once for each of four web frameworks, and\n"
        "compares the results. Each run starts a fresh kernel with the package\n"
        "name as its parameter and comes back with the named results.\n"
        "\n"
        f"It needs a [Ganymede]({GANYMEDE}/programs) server, which answers\n"
        "`jupyter.host()`, and a grant that lets this notebook run the other:\n"
        "\n"
        "```sh\n"
        "ganymede grant compare-packages.ipynb run=package-stats.ipynb\n"
        "```\n"
        "\n"
        "Without a server, `jupyter.host()` resolves to `null` and the notebook\n"
        "stops at the first cell, as it would under plain Jupyter."
    ),
    md("## The host"),
    code(
        "const host = await jupyter.host();\n"
        'if (!host) throw new Error("No Ganymede server: open this notebook under ganymede lab or ganymede execute.");\n'
        'host.has("notebooks.run")'
    ),
    md(
        "## Run the notebook for each package\n"
        "\n"
        "`host.notebooks.run` runs the notebook to the end and answers with its\n"
        "named results. The runs here go one after another; `Promise.all` would\n"
        "run them at once, each in its own kernel."
    ),
    code(
        'const packages = ["express", "fastify", "hono", "koa"];\n'
        "\n"
        "type Stats = { package: string; latest: string; stable_releases: number; first_release: string; weekly_downloads: number };\n"
        "const rows: Stats[] = [];\n"
        "for (const pkg of packages) {\n"
        '  const run = await host.notebooks.run({ path: "package-stats.ipynb", params: { pkg } });\n'
        "  rows.push(run.results as Stats);\n"
        "}\n"
        "rows.map((r) => `${r.package}: ${r.weekly_downloads}`)"
    ),
    md(
        "The results are data the other notebook wrote, so this one treats them\n"
        "as values, never as code to run.\n"
        "\n"
        "## Compare"
    ),
    code(
        "jupyter.md`| Package | Latest | Stable releases | First release | Downloads last week |\n"
        "| --- | --- | ---: | --- | ---: |\n"
        "${rows.map((r) => `| ${r.package} | ${r.latest} | ${r.stable_releases} | ${r.first_release} | ${r.weekly_downloads.toLocaleString(\"en\")} |`).join(\"\\n\")}`"
    ),
    code(
        'import * as vl from "npm:vega-lite-api@5";\n'
        "\n"
        "vl.markBar()\n"
        "  .data(rows)\n"
        "  .encode(\n"
        '    vl.y().fieldN("package").sort("-x").title(null),\n'
        '    vl.x().fieldQ("weekly_downloads").title("downloads last week"),\n'
        '    vl.tooltip(["package", "latest", "weekly_downloads"]),\n'
        "  )\n"
        "  .width(460)\n"
        "  .height(160)"
    ),
    md(
        "## Publish\n"
        "\n"
        "This notebook is a program too: its own named results are there for\n"
        "whoever runs it."
    ),
    code(
        "const top = rows.toSorted((a, b) => b.weekly_downloads - a.weekly_downloads)[0];\n"
        'jupyter.result("most_downloaded", top.package);\n'
        'jupyter.result("downloads", Object.fromEntries(rows.map((r) => [r.package, r.weekly_downloads])));'
    ),
    md(
        "## Next\n"
        "\n"
        f"- [Other notebooks: `jupyter.host()`]({DOCS}/jupyter-api#other-notebooks-jupyter-host)\n"
        "  has the other host calls: `list`, `read`, `search` and `results`.\n"
        f"- [Notebooks as programs]({GANYMEDE}/programs) in Ganymede's docs has the\n"
        "  grants, and running a notebook from a link or a Shortcut."
    ),
])

for name, nb in [("package-stats", stats), ("compare-packages", compare)]:
    nbf.write(nb, HERE / f"{name}.ipynb")
    print(f"wrote {HERE / f'{name}.ipynb'}")
