"""Builds examples/data-output.ipynb: tables, SQL and charts with
jupyter.table, jupyter.sql and jupyter.chart.

    uv run --with nbformat python examples/make_data_output_notebook.py
    uv run --with nbclient --with nbformat python examples/run_notebook.py --nb data-output node

The second command runs it on cdp-node and saves data-output.node.ipynb,
the copy the docs show. The first run installs DuckDB, Vega, Vega-Lite,
linkedom and Observable Plot from npm, and the notebook reads a CSV from
the Vega datasets on GitHub.
"""

from pathlib import Path

import nbformat as nbf

HERE = Path(__file__).resolve().parent

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
W = "https://raw.githubusercontent.com/vega/vega-datasets/v2.11.0/data/seattle-weather.csv"

nb.cells = [
md("""# Tables, SQL and charts in a TypeScript notebook

Three calls on the `jupyter` namespace turn data into output that every reader can show: the Ganymede apps, JupyterLab, VS Code, a published page, and an agent reading the notebook as text.

- `jupyter.table` shows rows as a table.
- `` jupyter.sql`...` `` runs SQL on an in-memory DuckDB database; results show as tables.
- `jupyter.chart` draws a Vega-Lite spec or an Observable Plot chart as one SVG.

Each output also carries a short text summary, which is what an agent or a terminal sees."""),
md("""## Rows as a table

An array of objects is enough. Each column's type comes from its values and shows under its name."""),
code("""const moons = [
  { moon: "Io", radius_km: 1821.6, period_days: 1.769, discovered: new Date("1610-01-08"), group: "Galilean" },
  { moon: "Europa", radius_km: 1560.8, period_days: 3.551, discovered: new Date("1610-01-08"), group: "Galilean" },
  { moon: "Ganymede", radius_km: 2634.1, period_days: 7.155, discovered: new Date("1610-01-07"), group: "Galilean" },
  { moon: "Callisto", radius_km: 2410.3, period_days: 16.689, discovered: new Date("1610-01-07"), group: "Galilean" },
  { moon: "Amalthea", radius_km: 83.5, period_days: 0.498, discovered: new Date("1892-09-09"), group: "Inner" },
  { moon: "Thebe", radius_km: 49.3, period_days: 0.675, discovered: new Date("1979-03-05"), group: "Inner" },
  { moon: "Metis", radius_km: 21.5, period_days: 0.295, discovered: new Date("1979-03-04"), group: "Inner" },
  { moon: "Himalia", radius_km: 69.8, period_days: 250.56, discovered: new Date("1904-12-03"), group: "Irregular" },
  { moon: "Elara", radius_km: 43, period_days: 259.64, discovered: new Date("1905-01-05"), group: "Irregular" },
];
jupyter.table(moons, { title: "Some moons of Jupiter" });"""),
md("""## SQL over the notebook's own rows

`jupyter.sql.load` makes a DuckDB table from rows the notebook already has. In the tag, a `${value}` can't change the query: it is a bound parameter (a quoted literal in the browser)."""),
code("""await jupyter.sql.load("moons", moons);
const minRadius = 1000;
await jupyter.sql`
  select moon, radius_km, round(radius_km / 1737.4, 2) as moon_radii
  from moons
  where radius_km > ${minRadius}
  order by radius_km desc`;"""),
md("""## SQL over a file on the web

DuckDB reads CSV, Parquet and JSON by path or URL. This is four years of Seattle weather from the Vega datasets."""),
code(f"""await jupyter.sql.load("weather", "{W}");
await jupyter.sql`
  select weather, count(*) as days, round(avg(precipitation), 2) as avg_precip_mm
  from weather
  group by weather
  order by days desc`;"""),
md("""## A chart from a query, with Vega-Lite

A query's `rows` are plain objects, ready for a chart. The chart is drawn in the kernel, so the notebook holds an SVG that shows anywhere, with no chart library in the reader."""),
code("""const monthly = await jupyter.sql`
  select month(date) as month, year(date)::varchar as year, round(avg(temp_max), 1) as avg_high_c
  from weather
  group by all
  order by year, month`;

jupyter.chart({
  title: "Average daily high, Seattle",
  width: 520,
  height: 260,
  data: { values: monthly.rows },
  mark: { type: "line", point: true },
  encoding: {
    x: { field: "month", type: "ordinal", title: "Month" },
    y: { field: "avg_high_c", type: "quantitative", title: "°C" },
    color: { field: "year", type: "nominal", title: "Year" },
  },
});"""),
md("""## The same data with Observable Plot

Pass the Plot module and the options you would give `Plot.plot`. The title, subtitle and legend are drawn into the SVG, so they survive where a reader shows only images."""),
code("""import * as Plot from "npm:@observablehq/plot@0.6";

const byMonth = await jupyter.sql`
  select month(date) as month, weather, count(*) as days
  from weather
  group by all`;

jupyter.chart(Plot, {
  title: "What the weather was, by month",
  subtitle: "Days in 2012–2015",
  width: 640,
  color: { legend: true, domain: ["sun", "fog", "drizzle", "rain", "snow"], range: ["#f2b134", "#9aa5ad", "#7fb6d9", "#2f6db5", "#c9d6f2"] },
  x: { label: "Month", tickFormat: (m) => "JFMAMJJASOND"[m - 1] },
  y: { label: "Days", grid: true },
  marks: [Plot.barY(byMonth.rows, { x: "month", y: "days", fill: "weather", order: ["sun", "fog", "drizzle", "rain", "snow"] }), Plot.ruleY([0])],
});"""),
md("""A continuous color scale gets a ramp instead of swatches:"""),
code("""const days = await jupyter.sql`select date, temp_max, temp_min from weather where year(date) = 2015`;
jupyter.chart(Plot, {
  title: "Daily high, 2015",
  width: 640,
  height: 260,
  color: { legend: true, scheme: "turbo", label: "High (°C)" },
  y: { label: "°C", grid: true },
  marks: [Plot.dot(days.rows, { x: "date", y: "temp_max", fill: "temp_max", r: 3 })],
});"""),
md("""## Large results

A result shows up to 1,000 rows (`limit` raises it, up to 10,000), and always says how many there are. The apps page through them and sort by any column; a published page shows the first 100."""),
code("""await jupyter.sql`select * from weather order by date`;"""),
md("""## What an agent sees

Every one of these outputs carries a `text/plain` summary: the column types and ranges for a table, the marks and scales for a chart. That is what an agent reads, and what `jupyter console` prints."""),
code("""const result = await jupyter.sql`select * from weather`;
console.log((await jupyter.format(result))["text/plain"]);"""),
]

nbf.write(nb, HERE / "data-output.ipynb")
print("wrote", HERE / "data-output.ipynb")
