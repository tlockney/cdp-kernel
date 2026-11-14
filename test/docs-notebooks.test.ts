import { test } from "node:test";
import assert from "node:assert/strict";
import { cellsOf, stable } from "../docs/.vitepress/run-notebooks.ts";

// The docs runner (docs/.vitepress/run-notebooks.ts) saves notebooks in a
// form that a re-run with the same results leaves unchanged, and reads
// <!-- view sends for ...: --> comments into cell metadata.

function executed(modelId: string, other: string) {
  return JSON.stringify({
    cells: [
      {
        cell_type: "code",
        execution_count: 1,
        id: "a",
        metadata: { execution: { "iopub.status.busy": "2026-11-14T00:00:00Z" } },
        outputs: [{
          data: { "application/vnd.jupyter.widget-view+json": { model_id: modelId }, "text/plain": [`Widget(${modelId})`] },
          metadata: {},
          output_type: "execute_result",
          execution_count: 1,
        }],
        source: ["const w = 1;\n", `"${other}"`],
      },
    ],
    metadata: {
      kernelspec: { name: "cdp-node" },
      language_info: { name: "typescript" },
      widgets: { "application/vnd.jupyter.widget-state+json": { state: { [modelId]: { state: { count: 3 } } } } },
    },
    nbformat: 4,
    nbformat_minor: 5,
  });
}

test("stable() gives the same text for runs with different model ids", () => {
  const other = "0123456789abcdef0123456789abcdef";
  const a = stable(executed("4d761583-e270-45d5-876c-e3ebf1701a44", other));
  const b = stable(executed("bb8c5bcb-a7ee-47f4-9d34-c8db2ac799b4", other));
  assert.equal(a, b);
  const nb = JSON.parse(a);
  assert.deepEqual(Object.keys(nb.metadata.widgets["application/vnd.jupyter.widget-state+json"].state), ["widget-1"]);
  assert.equal(nb.cells[0].outputs[0].data["application/vnd.jupyter.widget-view+json"].model_id, "widget-1");
  // A hex string that isn't a saved model id is left alone.
  assert.match(nb.cells[0].source, new RegExp(other));
  assert.equal(nb.cells[0].source, `const w = 1;\n"${other}"`);
  assert.deepEqual(nb.cells[0].metadata, {});
  assert.equal(nb.metadata.language_info, undefined);
  assert.deepEqual(Object.keys(nb.cells[0]), ["id", "cell_type", "source", "metadata", "outputs", "execution_count"]);
});

test("cellsOf() reads a view sends comment into the cell's metadata", () => {
  const page = [
    "Intro.",
    "",
    "```ts cell",
    "w;",
    "```",
    "",
    '<!-- view sends for a click: [{"method": "custom", "content": {"count": 3}}] -->',
    "",
    "After.",
  ].join("\n");
  const cells = cellsOf(page, "/docs/page.md");
  assert.deepEqual(cells.map((c) => c.cell_type), ["markdown", "code", "markdown"]);
  assert.deepEqual(cells[1].metadata, {
    docs: { view_sent: "a click", view_sends: [{ method: "custom", content: { count: 3 } }] },
  });
  assert.ok(!JSON.stringify(cells[2].source).includes("view sends"));
});
