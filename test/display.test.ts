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
  });
  assert.deepEqual(await jupyter.namespace.format({ toSpec: () => lite4 }), {
    "application/vnd.vegalite.v4+json": lite4,
  });
  assert.deepEqual(await jupyter.namespace.format({ toSpec: () => vega }), {
    "application/vnd.vega.v5+json": vega,
  });
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
