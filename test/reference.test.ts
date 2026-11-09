import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import ts from "typescript";
import { generate, root, stale } from "../scripts/reference.ts";

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
