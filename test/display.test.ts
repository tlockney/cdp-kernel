import { test } from "node:test";
import assert from "node:assert/strict";
import { createJupyter, escapeHTML, isJpg, isPng, type DisplayHost, type Jupyter } from "../runtime/display.mjs";

interface Sent {
  msgType: string;
  content: Record<string, unknown>;
  metadata: object;
  buffers: Uint8Array[];
}

function setup(input: (prompt: string, password: boolean) => string | null = () => null): {
  jupyter: Jupyter;
  sent: Sent[];
  prompts: { prompt: string; password: boolean }[];
} {
  const sent: Sent[] = [];
  const prompts: { prompt: string; password: boolean }[] = [];
  const host: DisplayHost = {
    inspect: (value) => `<${typeof value}:${String(value)}>`,
    base64: (bytes) => `b64(${bytes.length})`,
    readFile: () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    send: (msgType, content, metadata, buffers) =>
      void sent.push({ msgType, content: content as Record<string, unknown>, metadata, buffers }),
    input: (prompt, password) => {
      prompts.push({ prompt, password });
      return input(prompt, password);
    },
  };
  return { jupyter: createJupyter(host), sent, prompts };
}

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]);
const JPG = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]);

test("escapeHTML escapes the five special characters", () => {
  assert.equal(escapeHTML(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  assert.equal(escapeHTML("plain"), "plain");
});

test("isPng and isJpg detect image bytes", () => {
  assert.equal(isPng(PNG), true);
  assert.equal(isPng(JPG), false);
  assert.equal(isPng(new Uint8Array([137, 80])), false);
  assert.equal(isPng([137, 80, 78, 71, 13, 10, 26, 10]), false);
  assert.equal(isJpg(JPG), true);
  assert.equal(isJpg(PNG), false);
  assert.equal(isJpg(new Uint8Array([0xff, 0xd8])), false);
  assert.equal(isJpg("str"), false);
});

test("format: display symbol, sync and async", async () => {
  const { jupyter } = setup();
  const { namespace } = jupyter;
  const sync = { [namespace.$display]: () => ({ "text/plain": "sync" }) };
  const asyncObj = { [namespace.$display]: () => Promise.resolve({ "text/plain": "async" }) };
  assert.deepEqual(await namespace.format(sync), { "text/plain": "sync" });
  assert.deepEqual(await namespace.format(asyncObj), { "text/plain": "async" });
});

test("format: primitives and plain objects use the injected inspect", async () => {
  const { jupyter } = setup();
  assert.deepEqual(await jupyter.namespace.format(5), { "text/plain": "<number:5>" });
  assert.deepEqual(await jupyter.namespace.format(null), { "text/plain": "<object:null>" });
  assert.deepEqual(await jupyter.namespace.format(undefined), { "text/plain": "<undefined:undefined>" });
  assert.deepEqual(await jupyter.namespace.format({}), { "text/plain": "<object:[object Object]>" });
});

test("format: canvas-like toDataURL", async () => {
  const { jupyter } = setup();
  const canvas = { toDataURL: () => "data:image/png;base64,AAAA" };
  assert.deepEqual(await jupyter.namespace.format(canvas), { "image/png": "AAAA" });
});

test("format: Vega-like objects choose the media type from the schema", async () => {
  const { jupyter } = setup();
  const lite5 = { $schema: "https://vega.github.io/schema/vega-lite/v5.json", mark: "bar" };
  const lite4 = { $schema: "https://vega.github.io/schema/vega-lite/v4.json" };
  const vega = { $schema: "https://vega.github.io/schema/vega/v5.json" };
  assert.deepEqual(await jupyter.namespace.format({ toSpec: () => lite5 }), {
    "application/vnd.vegalite.v5+json": lite5,
    "text/plain": "Vega-Lite bar chart",
  });
  assert.deepEqual(await jupyter.namespace.format({ toSpec: () => lite4 }), {
    "application/vnd.vegalite.v4+json": lite4,
    "text/plain": "Vega-Lite chart",
  });
  assert.deepEqual(await jupyter.namespace.format({ toSpec: () => vega }), {
    "application/vnd.vega.v5+json": vega,
    "text/plain": "Vega chart",
  });
});

async function chartText(spec: object): Promise<unknown> {
  const { jupyter } = setup();
  return (await jupyter.namespace.format({ toSpec: () => spec }))["text/plain"];
}

const LITE = "https://vega.github.io/schema/vega-lite/v5.json";

test("format: Vega-Lite text/plain names the mark, encodings, ranges and rows", async () => {
  const values = [
    { region: "East", sales: 120 },
    { region: "North", sales: 980 },
    { region: "South", sales: 300.25 },
    { region: "West", sales: 410 },
  ];
  assert.equal(
    await chartText({
      $schema: LITE,
      title: "Sales by region",
      data: { values },
      mark: { type: "bar" },
      encoding: {
        x: { field: "region", type: "nominal" },
        y: { field: "sales", type: "Q" },
        color: { value: "steelblue" },
        tooltip: { field: "sales" },
      },
    }),
    'Vega-Lite bar chart "Sales by region": x=region (nominal, 4 values), y=sales (quantitative, 120 to 980), 4 rows',
  );
});

test("format: Vega-Lite text/plain reads named datasets, nested fields and dates", async () => {
  assert.equal(
    await chartText({
      $schema: LITE,
      datasets: { d: [{ t: "2024-03-01", p: { v: -1.23456 } }, { t: "2023-01-15", p: { v: 2 } }] },
      data: { name: "d" },
      mark: "line",
      encoding: { x: { field: "t", type: "temporal" }, y: { field: "p.v", type: "quantitative" } },
    }),
    "Vega-Lite line chart: x=t (temporal, 2023-01-15 to 2024-03-01), y=p.v (quantitative, -1.235 to 2), 2 rows",
  );
});

test("format: Vega-Lite text/plain shows aggregates and a data URL without ranges", async () => {
  assert.equal(
    await chartText({
      $schema: LITE,
      data: { url: "data/cars.json" },
      mark: "point",
      encoding: {
        x: { field: "Year", timeUnit: "year", type: "temporal" },
        y: { aggregate: "count", type: "quantitative" },
      },
    }),
    "Vega-Lite point chart: x=year(Year) (temporal), y=count() (quantitative), data from data/cars.json",
  );
});

test("format: Vega-Lite text/plain gives a line per layer, view and panel", async () => {
  const values = [{ a: 1, b: "x" }, { a: 3, b: "y" }];
  assert.equal(
    await chartText({
      $schema: LITE,
      title: { text: "Layers" },
      data: { values },
      encoding: { x: { field: "b", type: "ordinal" } },
      layer: [
        { mark: "bar", encoding: { y: { field: "a", type: "quantitative" } } },
        { mark: "rule", encoding: { y: { aggregate: "mean", field: "a", type: "quantitative" } } },
      ],
    }),
    [
      'Vega-Lite layered chart "Layers": 2 layers, 2 rows',
      "  layer 1: bar chart: x=b (ordinal, 2 values), y=a (quantitative, 1 to 3)",
      "  layer 2: rule chart: x=b (ordinal, 2 values), y=mean(a) (quantitative)",
    ].join("\n"),
  );
  assert.equal(
    await chartText({
      $schema: LITE,
      data: { values },
      facet: { column: { field: "b", type: "nominal" } },
      spec: { mark: "point", encoding: { y: { field: "a", type: "quantitative" } } },
    }),
    "Vega-Lite chart faceted by b, 2 rows\n  each panel: point chart: y=a (quantitative, 1 to 3)",
  );
  const views = Array.from({ length: 8 }, () => ({ mark: "area" }));
  const text = await chartText({ $schema: LITE, hconcat: views }) as string;
  assert.equal(text.split("\n").length, 1 + 6 + 1);
  assert.match(text, /^Vega-Lite concatenated chart: 8 views\n {2}view 1: area chart\n/);
  assert.match(text, /\n {2}… 2 more$/);
});

test("format: Vega text/plain lists marks, data sets and scales", async () => {
  assert.equal(
    await chartText({
      $schema: "https://vega.github.io/schema/vega/v5.json",
      title: "Bars",
      data: [
        { name: "table", values: [{ a: 1 }, { a: 2 }] },
        { name: "stats", source: "table" },
        { name: "remote", url: "data/x.csv" },
      ],
      scales: [{ name: "x", type: "band" }, { name: "y" }],
      marks: [{ type: "rect" }, { type: "group", marks: [{ type: "text" }, { type: "rect" }] }],
    }),
    'Vega chart "Bars": marks rect, group, text; data table (2 rows), stats (from table), remote (from data/x.csv); scales x (band), y (linear)',
  );
});

test("format: a spec the summary can't read still renders without text/plain", async () => {
  const spec = { $schema: LITE, mark: "bar", get encoding(): never {
    throw new Error("boom");
  } };
  const { jupyter } = setup();
  const out = await jupyter.namespace.format({ toSpec: () => spec });
  assert.deepEqual(Object.keys(out), ["application/vnd.vegalite.v5+json"]);
});

test("format: Vega-like without $schema falls through", async () => {
  const { jupyter } = setup();
  const out = await jupyter.namespace.format({ toSpec: () => ({ mark: "bar" }) });
  assert.deepEqual(Object.keys(out), ["text/plain"]);
});

test("format: DataFrame-like gives dataresource and an escaped html table", async () => {
  const { jupyter } = setup();
  const dtype = (name: string) => ({ toJSON: () => ({ DataType: name }) });
  const rows = Array.from({ length: 60 }, (_, i) => ({ "a<b": i, s: i === 0 ? "<x&y>" : "ok" }));
  const df = {
    schema: { "a<b": dtype("Int64"), s: dtype("Utf8"), z: dtype("Weird"), f: {} },
    head: (n: number) => ({ toRecords: () => rows.slice(0, n) }),
    toRecords: () => rows,
  };
  const out = await jupyter.namespace.format(df);
  const resource = out["application/vnd.dataresource+json"] as {
    data: unknown[];
    schema: { fields: { name: string; type: string }[] };
  };
  assert.deepEqual(resource.schema.fields, [
    { name: "a<b", type: "integer" },
    { name: "s", type: "string" },
    { name: "z", type: "string" },
    { name: "f", type: "string" },
  ]);
  assert.equal(resource.data.length, 50);
  const html = out["text/html"] as string;
  assert.match(html, /<th>a&lt;b<\/th>/);
  assert.match(html, /<td>&lt;x&amp;y&gt;<\/td>/);
  assert.equal(html.split("<tr>").length - 1, 1 + 10); // header + 10 rows
  assert.equal(out["text/plain"], "DataFrame (4 columns): a<b (integer), s (string), z (string), f (string)");
});

test("format: DataFrame text/plain gives the row count from height", async () => {
  const { jupyter } = setup();
  const columns = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`c${i}`, {}]));
  const df = { schema: columns, height: 1, head: () => ({ toRecords: () => [] }), toRecords: () => [] };
  const text = (await jupyter.namespace.format(df))["text/plain"] as string;
  assert.match(text, /^DataFrame \(1 row, 22 columns\): c0 \(string\), c1 \(string\), /);
  assert.match(text, /c19 \(string\), … 2 more$/);
});

test("format: PNG and JPEG bytes use the injected base64", async () => {
  const { jupyter } = setup();
  assert.deepEqual(await jupyter.namespace.format(PNG), { "image/png": "b64(10)" });
  assert.deepEqual(await jupyter.namespace.format(JPG), { "image/jpeg": "b64(6)" });
});

test("format: outerHTML svg vs html", async () => {
  const { jupyter } = setup();
  assert.deepEqual(await jupyter.namespace.format({ outerHTML: "<svg></svg>" }), { "image/svg+xml": "<svg></svg>" });
  assert.deepEqual(await jupyter.namespace.format({ outerHTML: "<p>hi</p>" }), { "text/html": "<p>hi</p>" });
});

test("md, html and svg tagged templates", async () => {
  const { jupyter } = setup();
  const { md, html, svg, format } = jupyter.namespace;
  const n = 3;
  assert.deepEqual(await format(md`# a ${n} b`), { "text/markdown": "# a 3 b" });
  assert.deepEqual(await format(html`<b>${"x"}</b>${undefined}`), { "text/html": "<b>x</b>" });
  assert.deepEqual(await format(svg`<svg/>`), { "image/svg+xml": "<svg/>" });
});

test("image accepts bytes or a path and rejects other data", async () => {
  const { jupyter } = setup();
  const { image, format } = jupyter.namespace;
  assert.deepEqual(await format(image(JPG)), { "image/jpeg": "b64(6)" });
  assert.deepEqual(await format(image(PNG)), { "image/png": "b64(10)" });
  assert.deepEqual(await format(image("/some/path.png")), { "image/png": "b64(8)" });
  assert.throws(() => image(new Uint8Array([1, 2, 3])), TypeError);
});

test("image of a path that can't be read throws Deno's TypeError", () => {
  const host: DisplayHost = {
    inspect: String,
    base64: () => "",
    readFile: (path) => {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
    },
    send: () => {},
    input: () => null,
  };
  assert.throws(() => createJupyter(host).namespace.image("/missing.png"), {
    name: "TypeError",
    message: /not a valid image or a path to an image/,
  });
});

test("display sends display_data with an empty transient by default", async () => {
  const { jupyter, sent } = setup();
  await jupyter.namespace.display(7);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].msgType, "display_data");
  assert.deepEqual(sent[0].content, { data: { "text/plain": "<number:7>" }, metadata: {}, transient: {} });
});

test("display with update and display_id sends update_display_data", async () => {
  const { jupyter, sent } = setup();
  await jupyter.namespace.display("x", { update: true, display_id: "id-1" });
  assert.equal(sent[0].msgType, "update_display_data");
  assert.deepEqual(sent[0].content.transient, { display_id: "id-1" });
  await jupyter.namespace.display("y", { display_id: "id-2" });
  assert.equal(sent[1].msgType, "display_data");
  assert.deepEqual(sent[1].content.transient, { display_id: "id-2" });
});

test("display with raw sends a media bundle as is", async () => {
  const { jupyter, sent } = setup();
  const bundle = { "text/plain": "p", "text/html": "<i>p</i>" };
  await jupyter.namespace.display(bundle, { raw: true });
  assert.deepEqual(sent[0].content.data, bundle);
});

test("broadcast forwards metadata and buffers", () => {
  const { jupyter, sent } = setup();
  const buf = new Uint8Array([1]);
  jupyter.namespace.broadcast("custom", { a: 1 }, { metadata: { m: 2 }, buffers: [buf] });
  assert.equal(sent[0].msgType, "custom");
  assert.deepEqual(sent[0].metadata, { m: 2 });
  assert.deepEqual(sent[0].buffers, [buf]);
});

test("broadcastResult skips undefined", async () => {
  const { jupyter, sent } = setup();
  await jupyter.broadcastResult(1, undefined);
  assert.equal(sent.length, 0);
});

test("broadcastResult sends execute_result with transient {}", async () => {
  const { jupyter, sent } = setup();
  await jupyter.broadcastResult(4, 42);
  assert.equal(sent[0].msgType, "execute_result");
  assert.deepEqual(sent[0].content, {
    execution_count: 4,
    data: { "text/plain": "<number:42>" },
    metadata: {},
    transient: {},
  });
});

test("broadcastResult reports formatting failures as an error message", async () => {
  const { jupyter, sent } = setup();
  const { $display } = jupyter.namespace;
  const boom = new RangeError("cannot render");
  await jupyter.broadcastResult(1, {
    [$display]: () => {
      throw boom;
    },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].msgType, "error");
  assert.equal(sent[0].content.ename, "RangeError");
  assert.equal(sent[0].content.evalue, "cannot render");
  assert.ok(Array.isArray(sent[0].content.traceback));
  assert.match(String((sent[0].content.traceback as unknown[])[0]), /RangeError: cannot render/);
});

test("broadcastResult reports non-Error throws", async () => {
  const { jupyter, sent } = setup();
  const { $display } = jupyter.namespace;
  await jupyter.broadcastResult(1, {
    [$display]: () => {
      throw "plain string";
    },
  });
  assert.equal(sent[0].content.ename, "Error");
  assert.equal(sent[0].content.evalue, "plain string");
  assert.deepEqual(sent[0].content.traceback, []);
});

test("confirm asks with [y/N] and accepts y or Y", () => {
  for (const [answer, expected] of [["y", true], ["Y", true], ["n", false], ["yes", false], ["", false], [null, false]] as const) {
    const { jupyter, prompts } = setup(() => answer);
    assert.equal(jupyter.confirm("Sure?"), expected, String(answer));
    assert.deepEqual(prompts, [{ prompt: "Sure? [y/N] ", password: false }]);
  }
  const { jupyter, prompts } = setup(() => "y");
  jupyter.confirm();
  assert.equal(prompts[0].prompt, "Confirm [y/N] ");
});

test("prompt returns the answer, the default for empty, and passes password", () => {
  const a = setup(() => "typed");
  assert.equal(a.jupyter.prompt("Name?"), "typed");
  assert.deepEqual(a.prompts, [{ prompt: "Name?", password: false }]);

  const b = setup(() => "");
  assert.equal(b.jupyter.prompt("Name?", "bob"), "bob");
  assert.equal(b.prompts[0].prompt, "Name? [bob]");

  const c = setup(() => "s3cret");
  assert.equal(c.jupyter.prompt("Pw", "", { password: true }), "s3cret");
  assert.deepEqual(c.prompts, [{ prompt: "Pw", password: true }]);

  assert.equal(setup().jupyter.prompt(), null);
});
