import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeSVG,
  createChart,
  isPlotModule,
  legendSVG,
  LINKEDOM,
  summarizePlot,
  svgSize,
  VEGA,
  VEGA_LITE,
  withNamespace,
} from "../runtime/chart.mjs";

const $display = Symbol.for("Jupyter.display");
type Bundle = Record<string, string | object>;
const show = async (d: unknown) => (await (d as { [$display]: () => Promise<Bundle> })[$display]()) as Bundle;

/** vega and vega-lite stand-ins that record what they were given. */
function fakeVega() {
  const seen: { compiled?: any; parsed?: any; finalized: number } = { finalized: 0 };
  const vega = {
    parse: (spec: unknown) => (seen.parsed = spec),
    View: class {
      async toSVG() {
        return '<svg width="100" height="50"><text>chart</text></svg>';
      }
      finalize() {
        seen.finalized++;
      }
    },
  };
  const vl = { compile: (spec: unknown) => ({ spec: (seen.compiled = spec) }) };
  return { vega, vl, seen };
}

function setup(svg?: string) {
  const { vega, vl, seen } = fakeVega();
  const loads: string[] = [];
  const warnings: string[] = [];
  if (svg) vega.View.prototype.toSVG = async () => svg;
  const modules: Record<string, unknown> = { [VEGA]: vega, [VEGA_LITE]: vl, [LINKEDOM]: { parseHTML: () => ({ document: { fake: true } }) } };
  const chart = createChart({
    importModule: async (s) => {
      loads.push(s);
      return modules[s];
    },
    summarizeSpec: (spec) => `summary of ${(spec as { mark?: string }).mark}`,
    warn: (m) => warnings.push(m),
  });
  return { chart, loads, warnings, seen };
}

const scale = (type: string, domain: unknown[], label?: string) => ({
  type,
  domain,
  label,
  apply: (v: unknown) => (v === "a" || v === 0 ? "#111111" : "#222222"),
});

/** A Plot stand-in: plot() returns an element with scales. */
function fakePlot() {
  const given: Record<string, unknown>[] = [];
  const Plot = {
    barY: () => ({}),
    plot(options: Record<string, unknown>) {
      given.push(options);
      return {
        outerHTML: '<svg viewBox="0 0 300 200" class="plot"><g/></svg>',
        scale: (name: string) => (name === "color" ? scale("ordinal", ["a", "b"]) : name === "y" ? scale("linear", [0, 3], "↑ b") : undefined),
      };
    },
  };
  return { Plot, given };
}

test("a Vega-Lite spec renders to SVG with a summary and the default config", async () => {
  const { chart, loads, seen } = setup();
  const bundle = await show(chart({ mark: "bar", config: { axis: { labelColor: "red" } } }));
  assert.deepEqual(Object.keys(bundle).sort(), ["image/svg+xml", "text/plain"]);
  assert.match(bundle["image/svg+xml"] as string, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.equal(bundle["text/plain"], "summary of bar");
  assert.deepEqual(loads, [VEGA, VEGA_LITE]);
  assert.equal(seen.compiled.config.background, "transparent");
  assert.equal(seen.compiled.config.axis.labelColor, "red", "the spec's config wins");
  assert.equal(seen.compiled.config.axis.tickColor, "currentColor");
  assert.equal(seen.finalized, 1);
});

test("toSpec() is called once, when chart is called", async () => {
  const { chart } = setup();
  let calls = 0;
  await show(chart({ toSpec: () => (calls++, { mark: "bar" }) }));
  assert.equal(calls, 1);
});

test("a Vega spec skips vega-lite; { spec: true } keeps the spec", async () => {
  const { chart, loads, seen } = setup();
  const spec = { $schema: "https://vega.github.io/schema/vega/v5.json", marks: [] };
  const bundle = await show(chart(spec, { spec: true }));
  assert.deepEqual(loads, [VEGA]);
  assert.equal(seen.compiled, undefined);
  assert.deepEqual(bundle["application/vnd.vega.v5+json"], spec);
  const vl = await show(chart({ toSpec: () => ({ mark: "line" }) }, { spec: true }));
  assert.deepEqual(vl["application/vnd.vegalite.v5+json"], { mark: "line" });
});

test("rendering happens once, on display", async () => {
  const { chart, loads } = setup();
  const d = chart({ mark: "bar" });
  assert.deepEqual(loads, []);
  await show(d);
  await show(d);
  assert.equal(loads.length, 2);
});

test("a wrong argument fails the call", () => {
  const { chart } = setup();
  const { Plot } = fakePlot();
  assert.throws(() => chart([1, 2]), TypeError);
  assert.throws(() => chart("bar"), TypeError);
  assert.throws(() => chart(Plot), /options must be/);
});

test("Plot: title, subtitle, caption and legend are drawn into one SVG", async () => {
  const { chart, loads } = setup();
  const { Plot, given } = fakePlot();
  const bundle = await show(chart(Plot, {
    title: "T <1>",
    subtitle: "S",
    caption: "C",
    color: { legend: true, label: "kind" },
    marks: [{ ariaLabel: "bar", data: [1, 2, 3] }],
  }));
  assert.deepEqual(loads, [LINKEDOM]);
  assert.deepEqual(given[0].document, { fake: true });
  assert.equal(given[0].title, undefined, "Plot doesn't draw the title itself");
  assert.equal((given[0].color as { legend: boolean }).legend, false);
  const svg = bundle["image/svg+xml"] as string;
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="300"/);
  assert.match(svg, />T &lt;1&gt;</);
  assert.match(svg, />S</);
  assert.match(svg, />C</);
  assert.match(svg, />kind</);
  assert.match(svg, /fill="#111111"/);
  assert.match(svg, /<svg x="0" y="\d+" xmlns=/);
  assert.equal(bundle["text/plain"], 'Plot bar chart "T <1>": y=↑ b (linear, 0 to 3), color (ordinal, 2 values), 3 rows');
});

test("a page's own document is used for Plot when there is one", async () => {
  const { chart, loads } = setup();
  const { Plot, given } = fakePlot();
  const doc = { createElementNS() {} };
  (globalThis as { document?: unknown }).document = doc;
  try {
    await show(chart(Plot, { marks: [] }));
  } finally {
    delete (globalThis as { document?: unknown }).document;
  }
  assert.deepEqual(loads, []);
  assert.equal(given[0].document, doc);
});

test("an SVG element shows as it is", async () => {
  const { chart } = setup();
  const bundle = await show(chart({ outerHTML: "<svg><g/></svg>" }));
  assert.deepEqual(bundle, { "image/svg+xml": '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>' });
});

test("a large SVG logs a warning", async () => {
  const { chart, warnings } = setup(`<svg>${"x".repeat(2_100_000)}</svg>`);
  await show(chart({ mark: "point" }));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2\.1 MB/);
});

test("Plot: legend \"ramp\" or \"swatches\" picks the form; other scales' legends warn", async () => {
  const { chart, warnings } = setup();
  const { Plot } = fakePlot();
  const ramp = (await show(chart(Plot, { color: { legend: "ramp" }, marks: [] })))["image/svg+xml"] as string;
  assert.match(ramp, /<linearGradient/);
  const swatches = (await show(chart(Plot, { color: { legend: "swatches" }, marks: [] })))["image/svg+xml"] as string;
  assert.match(swatches, /<rect x="0" y="0" width="10" height="10" fill="#111111"\/>/);
  assert.deepEqual(warnings, []);
  await show(chart(Plot, { symbol: { legend: true }, r: { legend: true }, marks: [] }));
  assert.deepEqual(warnings, ["jupyter.chart draws only a color legend; the r, symbol legend is left out"]);
});

test("the same continuous legend gives the same SVG", () => {
  const a = legendSVG(scale("linear", [0, 10]), 400).svg;
  assert.equal(a, legendSVG(scale("linear", [0, 10]), 400).svg);
  assert.match(a, /<linearGradient id="ramp-[0-9a-z]+"/);
});

test("legends: swatches for categories, a ramp for a continuous scale", () => {
  const cat = legendSVG(scale("ordinal", ["a", "b"], "kind"), 400);
  assert.match(cat.svg, /<rect x="0" y="16" width="10" height="10" fill="#111111"\/>/);
  assert.equal(cat.height, 30);
  const ramp = legendSVG(scale("linear", [0, 10]), 400);
  assert.match(ramp.svg, /<linearGradient/);
  assert.match(ramp.svg, />0</);
  assert.match(ramp.svg, />10</);
  assert.deepEqual(legendSVG(undefined, 400), { svg: "", height: 0 });
  // Swatches wrap at the chart's width.
  const many = legendSVG(scale("ordinal", Array.from({ length: 30 }, (_, i) => `category ${i}`)), 300);
  assert.ok(many.height > 50);
});

test("SVG helpers", () => {
  assert.deepEqual(svgSize('<svg width="10" height="20">'), { width: 10, height: 20 });
  assert.deepEqual(svgSize('<svg viewBox="0 0 30 40">'), { width: 30, height: 40 });
  assert.deepEqual(svgSize("<g/>"), { width: 640, height: 400 });
  assert.equal(withNamespace('<svg xmlns="x"/>'), '<svg xmlns="x"/>');
  assert.match(composeSVG('<svg width="10" height="20"></svg>', {}), /height="20" viewBox="0 0 10 20"/);
  assert.equal(isPlotModule({ plot() {}, barY() {} }), true);
  assert.equal(isPlotModule({ plot() {} }), false);
  assert.equal(summarizePlot({}, { marks: [] }), "Plot chart");
});
