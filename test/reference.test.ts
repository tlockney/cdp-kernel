import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import ts from "typescript";
import { anchors, generate, root, stale } from "../scripts/reference.ts";

// The reference pages are generated from the doc comments on the notebook
// globals' types (ganymede#596): they must be current, cover every member,
// and every example must type-check against those types.

const result = generate();

test("reference pages match the doc comments", () => {
  assert.deepEqual(stale(result), [], "run node scripts/reference.ts --write");
});

test("every member has a summary, its parameters and an example", () => {
  assert.deepEqual(result.problems, []);
  assert.ok(result.examples.length > 20, `only ${result.examples.length} examples`);
});

test("every example type-checks against the notebook globals", () => {
  // Each example is its own module (top-level await is allowed), next to
  // the globals entry so `jupyter`, `prompt` and `confirm` are declared.
  const dir = join(root, "docs", ".reference-examples");
  const files = new Map(result.examples.map((e, i) => [join(dir, `example-${i}.ts`), `export {};\n${e.code}\n`]));
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    erasableSyntaxOnly: true,
    skipLibCheck: true,
    types: ["node"],
    // Statements like `counter;` show a value in a notebook.
    allowUnreachableCode: true,
  };
  const host = ts.createCompilerHost(options);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (f) => files.has(f) || fileExists.call(host, f);
  host.readFile = (f) => files.get(f) ?? readFile.call(host, f);
  host.getSourceFile = (f, lang, ...rest) => {
    const text = files.get(f);
    return text === undefined ? getSourceFile.call(host, f, lang, ...rest) : ts.createSourceFile(f, text, lang);
  };
  const program = ts.createProgram([join(root, "src", "globals.ts"), ...files.keys()], options, host);
  const errors = ts.getPreEmitDiagnostics(program).map((d) => {
    const file = d.file?.fileName ?? "";
    const i = [...files.keys()].indexOf(file);
    const where = i >= 0 ? result.examples[i].where : file;
    return `${where}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
  });
  assert.deepEqual(errors, []);
});

test("@see anchors: fenced headings don't count, repeats and {#id} do", () => {
  const page = [
    "# Guide",
    "## Setup",
    "## Setup",
    "## Custom {#mine}",
    '<a id="raw"></a>',
    "````md",
    "```",
    "# four-backtick",
    "```",
    "````",
    "- a list item:",
    "  ```ts",
    "  # indented",
    "  ```",
    "~~~",
    "# tilde",
    "~~~",
  ].join("\n");
  const { title, ids } = anchors(page);
  assert.equal(title, "Guide");
  assert.deepEqual([...ids].sort(), ["guide", "mine", "raw", "setup", "setup-1"]);
});

test("the widgets page keeps the anchors other pages link to", () => {
  // Grouping the page (#485) moved headings down a level; the ids stay, so
  // links like cell-api/widgets#widget-model keep working.
  const { ids } = anchors(result.files.get("docs/widgets-reference.md") ?? "");
  for (const id of [
    "widget-model",
    "widget-get-key",
    "widget-set-key-value",
    "widget-on-event-listener",
    "widget-off-event-listener",
    "widget-send-content-buffers",
    "widget-close",
    "widget-fullstate",
    "jupyter-comm",
    "jupyter-comm-open-targetname-data-options",
    "jupyter-comm-registertarget-targetname-handler",
    "jupyter-comm-unregistertarget-targetname",
    "comm",
    "comm-send-data-options",
    "comm-close-data-options",
    "comm-onmsg-handler",
    "comm-onclose-handler",
    "types",
    "widgetoptions",
    "commmessage",
    "commsendoptions",
  ]) {
    assert.ok(ids.has(id), `#${id} is gone`);
  }
});
