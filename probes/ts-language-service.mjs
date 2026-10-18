// Can the TypeScript language service give a notebook typed completion and
// inspection (#263), and what does it cost?
//
//   node probes/ts-language-service.mjs [path/to/typescript] [path/to/tsgo]
//
// Without arguments it uses the repo's own typescript devDependency. Pass
// another typescript package directory (e.g. one with typescript@6) to
// compare, and a TypeScript 7 native binary to time its LSP server too.
// npm: imports install into a throwaway CDPK_CACHE_DIR (needs network).

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const tsPath = process.argv[2] ? resolve(process.argv[2]) : "typescript";
const tsgoPath = process.argv[3] ? resolve(process.argv[3]) : null;

const cache = mkdtempSync(join(tmpdir(), "cdpk-ts-probe-"));
process.env.CDPK_CACHE_DIR = cache;
const hooks = await import("../runtime/node-hooks.mjs");

const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`;
const ms = (t) => `${(performance.now() - t).toFixed(0)} ms`;
const heap = () => process.memoryUsage().heapUsed;

// --- 1. Loading typescript --------------------------------------------------

const heap0 = heap();
let t = performance.now();
const ts = require(tsPath);
console.log(`typescript ${ts.version}: require ${ms(t)}, heap +${mb(heap() - heap0)}`);

// --- 2. A language service over a notebook's cells --------------------------
// Each npm:/jsr: specifier maps to its installed alias through `paths`, so
// the documents keep the cell's own text and positions.

function installedPath(specifier) {
  const npm = specifier.startsWith("npm:");
  const pkg = npm ? hooks.parsePackageSpecifier(specifier.slice(4)) : hooks.jsrToNpm(specifier.slice(4));
  const { dir, alias } = hooks.ensureInstalled(pkg);
  return join(dir, "node_modules", alias) + pkg.subpath;
}

function createService(files, { types = ["node"], typeRoots } = {}) {
  const versions = new Map();
  const paths = {};
  const options = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    allowJs: true,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    lib: ["lib.esnext.d.ts"],
    types,
    typeRoots,
    paths,
  };
  const host = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: (f) => String(versions.get(f) ?? 0),
    getScriptSnapshot: (f) => {
      const text = files.get(f) ?? ts.sys.readFile(f);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => process.cwd(),
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (f) => files.has(f) || ts.sys.fileExists(f),
    readFile: (f) => files.get(f) ?? ts.sys.readFile(f),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  return {
    service,
    set(name, text) {
      for (const m of text.matchAll(/["']((?:npm|jsr):[^"']+)["']/g)) paths[m[1]] ??= [installedPath(m[1])];
      files.set(name, text);
      versions.set(name, (versions.get(name) ?? 0) + 1);
    },
  };
}

const notebook = join(process.cwd(), "notebook");
const cells = [
  `import { z } from "npm:zod@3";`,
  `const User = z.object({ name: z.string(), age: z.number() });\ntype User = z.infer<typeof User>;`,
  `/** Adds two numbers. */\nfunction add(a: number, b: number) { return a + b; }`,
  `const x = 1;`,
  `const x = "now a string";`,
  `import { readFileSync } from "node:fs";`,
];

/** Completion names at the end of `code`, after `before` cells. */
function complete(ls, file, code, opts = {}) {
  ls.set(file, code);
  const t = performance.now();
  const info = ls.service.getCompletionsAtPosition(file, code.length, opts);
  return { names: info?.entries.map((e) => e.name) ?? [], time: ms(t) };
}

function quickInfo(ls, file, code, pos) {
  ls.set(file, code);
  const t = performance.now();
  const info = ls.service.getQuickInfoAtPosition(file, pos);
  const text = info
    ? [ts.displayPartsToString(info.displayParts), ts.displayPartsToString(info.documentation)].filter(Boolean).join(" / ")
    : null;
  return { text, time: ms(t) };
}

// 2a. Everything in one file: the simplest model. A redeclared const is an
// error, and the name keeps its first type.
{
  const heap1 = heap();
  t = performance.now();
  const ls = createService(new Map());
  const file = `${notebook}/all.ts`;
  const first = complete(ls, file, `${cells.join("\n")}\nx.`);
  console.log(`\none file: first completion ${first.time} (incl. npm install ${ms(t)} total), heap +${mb(heap() - heap1)}`);
  console.log(`  x. ->`, first.names.slice(0, 6).join(", "), "...");
  const diag = ls.service.getSemanticDiagnostics(file).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  console.log(`  diagnostics:`, diag);
}

// 2b. One script per cell. A file with an import is a module, and its
// bindings are local to it, so a later cell can't see them; a file without
// one shares the global scope, where redeclaration is again an error. Each
// earlier cell becomes a module that re-exports into a global declaration
// instead: see 2c.

// 2c. History as one file in which each top-level name keeps only its newest
// declaration (older ones are dropped), plus the current cell after it.
function pruneHistory(sources) {
  const seen = new Set();
  const kept = [];
  for (const source of [...sources].reverse()) {
    const sf = ts.createSourceFile("cell.ts", source, ts.ScriptTarget.ESNext, true);
    let text = source;
    // Walk back to front so earlier offsets stay valid.
    for (const stmt of [...sf.statements].reverse()) {
      const names = declaredNames(stmt);
      if (names.length > 0 && names.every((n) => seen.has(n))) {
        text = text.slice(0, stmt.getFullStart()) + text.slice(stmt.getEnd());
      }
    }
    for (const stmt of sf.statements) for (const n of declaredNames(stmt)) seen.add(n);
    kept.unshift(text);
  }
  return kept.join("\n");
}

function declaredNames(stmt) {
  if (ts.isVariableStatement(stmt)) {
    return stmt.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []));
  }
  if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name) return [stmt.name.text];
  if (ts.isImportDeclaration(stmt) && stmt.importClause) {
    const c = stmt.importClause;
    const names = c.name ? [c.name.text] : [];
    if (c.namedBindings && ts.isNamedImports(c.namedBindings)) names.push(...c.namedBindings.elements.map((e) => e.name.text));
    if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) names.push(c.namedBindings.name.text);
    return names;
  }
  return [];
}

{
  const ls = createService(new Map());
  const file = `${notebook}/pruned.ts`;
  const history = pruneHistory(cells);
  const probes = [
    ["x.", "x is a string now"],
    ["User.shape.", "zod schema members"],
    ["const u: User = { name: 'a', age: 1 };\nu.", "a cell-declared type"],
    ["[1, 2].map((n) => n.toF", "inside an expression (runtime path can't)"],
    ["readFileSync(", "node:fs import"],
    ["jupyter.", "kernel global, no declarations loaded"],
  ];
  console.log(`\npruned history:`);
  for (const [cell, label] of probes) {
    const r = complete(ls, file, `${history}\n${cell}`);
    console.log(`  ${label}: ${cell.split("\n").at(-1)} -> [${r.names.slice(0, 5).join(", ")}${r.names.length > 5 ? ", ..." : ""}] (${r.names.length}, ${r.time})`);
  }
  const addAt = `${history}\nadd(1, 2)`;
  const q = quickInfo(ls, file, addAt, addAt.length - "add(1, 2)".length + 1);
  console.log(`  quick info on add: ${q.text} (${q.time})`);
  const help = ls.service.getSignatureHelpItems(file, addAt.length - 2, undefined);
  console.log(`  signature help in add(: ${help?.items.length ?? 0} item(s)`);
  globalThis.gc?.(); // run with --expose-gc for a settled figure
  console.log(`  heap with one service: ${mb(heap())}`);
}

// --- 3. Runtime globals -----------------------------------------------------

const deno = spawnSync("deno", ["types"], { encoding: "utf8" });
if (deno.status === 0) {
  t = performance.now();
  const denoFile = join(cache, "lib.deno.d.ts");
  writeFileSync(denoFile, deno.stdout);
  const ls = createService(new Map([[denoFile, deno.stdout]]), { types: [] });
  const r = complete(ls, `${notebook}/deno.ts`, `Deno.read`);
  console.log(`\ndeno types: ${mb(deno.stdout.length)} of declarations; Deno.read -> [${r.names.slice(0, 4).join(", ")}, ...] (${ms(t)} incl. service)`);
} else {
  console.log(`\ndeno types: deno not found`);
}

// --- 4. TypeScript 7's native LSP server ------------------------------------
// TypeScript 7 has no in-process language service; it runs as an LSP server.

if (tsgoPath) {
  t = performance.now();
  const child = spawn(tsgoPath, ["--lsp", "--stdio"], { stdio: ["pipe", "pipe", "inherit"] });
  let buffer = Buffer.alloc(0);
  const waiting = new Map();
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const header = buffer.indexOf("\r\n\r\n");
      if (header === -1) return;
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, header).toString())[1]);
      if (buffer.length < header + 4 + length) return;
      const msg = JSON.parse(buffer.subarray(header + 4, header + 4 + length).toString());
      buffer = buffer.subarray(header + 4 + length);
      if (msg.id !== undefined && waiting.has(msg.id)) waiting.get(msg.id)(msg);
      else if (msg.id !== undefined && msg.method) send({ jsonrpc: "2.0", id: msg.id, result: null });
    }
  });
  let nextId = 1;
  const send = (msg) => {
    const body = JSON.stringify(msg);
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  const request = (method, params) => new Promise((r) => {
    const id = nextId++;
    waiting.set(id, r);
    send({ jsonrpc: "2.0", id, method, params });
  });
  // The same notebook as 2c, with @types/node and zod, through a tsconfig on
  // disk: an LSP server reads its options from there, and `paths` maps the
  // npm: specifier as before.
  const root = mkdtempSync(join(tmpdir(), "cdpk-tsgo-"));
  const typeRoots = [join(process.cwd(), "node_modules", "@types")];
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "esnext", module: "preserve", moduleResolution: "bundler", allowImportingTsExtensions: true,
      strict: true, noEmit: true, skipLibCheck: true, lib: ["esnext"], types: ["node"], typeRoots,
      paths: { "npm:zod@3": [installedPath("npm:zod@3")] },
    },
  }));
  await request("initialize", { processId: process.pid, rootUri: `file://${root}`, capabilities: {} });
  send({ jsonrpc: "2.0", method: "initialized", params: {} });
  const uri = `file://${root}/cell.ts`;
  let version = 1;
  const at = async (method, cell, extra = {}) => {
    const text = `${pruneHistory(cells)}\n${cell}`;
    send({ jsonrpc: "2.0", method: version === 1 ? "textDocument/didOpen" : "textDocument/didChange", params: version === 1
      ? { textDocument: { uri, languageId: "typescript", version: version++, text } }
      : { textDocument: { uri, version: version++ }, contentChanges: [{ text }] } });
    const lines = text.split("\n");
    const position = { line: lines.length - 1, character: lines.at(-1).length - (extra.back ?? 0) };
    const t1 = performance.now();
    const res = await request(method, { textDocument: { uri }, position });
    return { result: res.result, time: ms(t1) };
  };
  const first = await at("textDocument/completion", "x.");
  const names = (r) => (r.result?.items ?? r.result ?? []).map((i) => i.label);
  console.log(`\ntsgo LSP: start+first completion ${ms(t)} (completion ${first.time}); x. -> [${names(first).slice(0, 4).join(", ")}, ...]`);
  const shape = await at("textDocument/completion", "User.shape.");
  console.log(`  User.shape. -> [${names(shape).join(", ")}] (${shape.time})`);
  const proc = await at("textDocument/completion", "process.versi");
  console.log(`  process.versi (@types/node) -> [${names(proc).filter((n) => n.startsWith("versi")).join(", ")}] (${proc.time})`);
  const hover = await at("textDocument/hover", "add(1, 2)", { back: 8 });
  console.log(`  hover on add: ${JSON.stringify(hover.result?.contents).slice(0, 120)} (${hover.time})`);
  const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
  console.log(`  server RSS: ${/VmRSS:\s+(.*)/.exec(status)?.[1] ?? "?"}`);
  child.kill();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nprocess RSS at end: ${mb(process.memoryUsage().rss)}`);
rmSync(cache, { recursive: true, force: true });
