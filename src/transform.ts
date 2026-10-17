// Turns a notebook cell (TypeScript/TSX, ES module syntax) into a script that
// CDP's Runtime.evaluate can run with replMode: true.
//
// Deno does this with deno_ast (swc) and `var_decl_imports: true`
// (cli/tools/repl/session.rs, evaluate_ts_expression). Here a type stripper
// (esbuild by default) does the TypeScript/JSX part and acorn finds the
// module syntax that a script can't contain:
//   import x, { y as z } from "m"  ->  var __cdpk_m0 = await __cdpk.import("m");
//                                     var x = __cdpk_m0["default"], z = __cdpk_m0["y"];
//   import("m")                    ->  __cdpk.import("m")
//   import.meta                    ->  __cdpk.meta
//   export const a = 1             ->  const a = 1
// `__cdpk` is installed in the target by runtime/bootstrap.mjs. Routing
// import() through it matters: code evaluated over the inspector has no
// module referrer, so Node rejects a bare import() ("A dynamic import
// callback was not specified").

import { type Node, parse, type Pattern, type Program, type VariableDeclaration } from "acorn";
import { full, recursive } from "acorn-walk";
import { LineMap } from "./sourcemap.ts";

export const SHIM = "__cdpk";

// Each cell first yields one macrotask. User code then runs as an ordinary
// task instead of nested inside the inspector's dispatch of Runtime.evaluate,
// which is what lets a Runtime.terminateExecution from the control session
// interrupt a busy loop. (Within that dispatch the inspector processes no
// other messages, so an interrupt would never be seen.)
const PRELUDE = `'use strict'; await ${SHIM}.tick();\n`;

/**
 * Each replMode cell also ends by yielding one macrotask, so the script
 * settles with no other microtasks queued ahead of the inspector's
 * then-callback. Until that callback runs, the inspector holds the result
 * promise only weakly, and a GC in between fails the evaluate with "Promise
 * was collected" (#55). A declaration has no completion value, so the
 * cell's value is unchanged; replMode lets `let` be declared again.
 */
export const SETTLE = `\n;let ${SHIM}_settled = await ${SHIM}.tick();`;

export class CellSyntaxError extends Error {
  override name: string = "SyntaxError";
}

export type JsxOptions =
  | { mode: "automatic"; importSource?: string; development: boolean }
  | { mode: "classic"; factory?: string; fragment?: string };

/**
 * Compiler options for cells, e.g. from a Deno project's compilerOptions
 * (see src/deno-config.ts). Without any, JSX compiles to classic
 * React.createElement calls, Deno's own default.
 */
export interface CellTransformOptions {
  jsx?: JsxOptions;
  experimentalDecorators?: boolean;
  /** What removes a cell's types and compiles its JSX; esbuild by default (#238). */
  typeStrip?: TypeStripperName | TypeStripper;
}

/**
 * Turns a TypeScript/TSX cell into JavaScript with ES module syntax left in
 * place, and with `mappings` (a source map's field, lines are enough) when
 * `sourcemap` is set, for the debugger. Throws CellSyntaxError for code it
 * rejects.
 */
export type TypeStripper = (
  code: string,
  options: CellTransformOptions,
  sourcemap: boolean,
) => { code: string; mappings: string };

export type TypeStripperName = "esbuild";

export function isTypeStripperName(value: unknown): value is TypeStripperName {
  return value === "esbuild";
}

const strippers = new Map<TypeStripperName, TypeStripper>();

/**
 * Loads a built-in type stripper. Transforms are synchronous, so a kernel
 * loads the one it uses before its first cell; only that one's module is
 * imported (#238).
 */
export async function loadTypeStripper(name: TypeStripperName): Promise<TypeStripper> {
  let stripper = strippers.get(name);
  if (stripper === undefined) {
    stripper = (await import("./strip-esbuild.ts")).stripTypes;
    strippers.set(name, stripper);
  }
  return stripper;
}

function typeStripper(choice: TypeStripperName | TypeStripper = "esbuild"): TypeStripper {
  if (typeof choice === "function") return choice;
  const stripper = strippers.get(choice);
  if (stripper === undefined) throw new Error(`the ${choice} type stripper isn't loaded (see loadTypeStripper)`);
  return stripper;
}

// esbuild compiles `import x = require("m")` to a `require` call, which a
// cell doesn't have (#143); `import type x = require("m")` is erased.
const IMPORT_REQUIRE = /^\s*(?:export\s+)?import\s+(?!type\s)[\w$]+\s*=\s*require\s*\(/m;

/** The stripper's output, with its source map's `mappings` when asked for. */
function stripTypesMapped(code: string, options: CellTransformOptions, sourcemap: boolean): { code: string; mappings: string } {
  if (IMPORT_REQUIRE.test(code)) {
    throw new CellSyntaxError('import x = require("m") is not supported in a cell; use import x from "m"');
  }
  return typeStripper(options.typeStrip)(code, options, sourcemap);
}

function stripTypes(code: string, options: CellTransformOptions): string {
  return stripTypesMapped(code, options, false).code;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

interface Named {
  type: string;
  name?: string;
  value?: unknown;
}

interface ImportSpecifierNode {
  type: "ImportSpecifier" | "ImportDefaultSpecifier" | "ImportNamespaceSpecifier";
  local: Named;
  imported?: Named;
}

interface ImportDeclarationNode extends Node {
  source: { value: unknown; raw?: string };
  specifiers: ImportSpecifierNode[];
  attributes?: Node[];
}

interface ExportNamedNode extends Node {
  declaration: Node | null;
  source: Node | null;
}

interface ExportDefaultNode extends Node {
  declaration: Node;
}

function importedName(spec: ImportSpecifierNode): string {
  const imported = spec.imported;
  if (!imported) return "default";
  return imported.type === "Literal" ? String(imported.value) : String(imported.name);
}

function rewriteImport(code: string, node: ImportDeclarationNode, index: number): string {
  const source = JSON.stringify(node.source.value);
  const attrs = node.attributes && node.attributes.length > 0
    ? `, { with: { ${node.attributes.map((a) => code.slice(a.start, a.end)).join(", ")} } }`
    : "";
  const load = `await ${SHIM}.import(${source}${attrs})`;
  // `void`: as a cell's last statement, the import isn't its result (#139).
  if (node.specifiers.length === 0) return `void ${load};`;
  const ns = `${SHIM}_m${index}`;
  const bindings = node.specifiers.map((spec) => {
    const local = String(spec.local.name);
    if (spec.type === "ImportNamespaceSpecifier") return `${local} = ${ns}`;
    return `${local} = ${ns}[${JSON.stringify(importedName(spec))}]`;
  });
  return `var ${ns} = ${load}; var ${bindings.join(", ")};`;
}

function parseCell(js: string): Program {
  try {
    return parse(js, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: false,
    });
  } catch (err) {
    throw new CellSyntaxError(err instanceof Error ? err.message : String(err));
  }
}

/** Rewrites module-only syntax in plain JavaScript into script syntax. */
export function rewriteModuleSyntax(js: string): string {
  const program = parseCell(js);

  const edits: Edit[] = [];
  let importIndex = 0;
  full(program, (node) => {
    switch (node.type) {
      case "ImportDeclaration": {
        const decl = node as ImportDeclarationNode;
        edits.push({ start: decl.start, end: decl.end, text: rewriteImport(js, decl, importIndex++) });
        break;
      }
      case "ImportExpression":
        // Replace just the `import` keyword; arguments stay as written.
        edits.push({ start: node.start, end: node.start + "import".length, text: `${SHIM}.import` });
        break;
      case "MetaProperty":
        if (js.slice(node.start, node.end).startsWith("import")) {
          edits.push({ start: node.start, end: node.end, text: `${SHIM}.meta` });
        }
        break;
      case "ExportNamedDeclaration": {
        const decl = node as ExportNamedNode;
        if (decl.declaration) {
          edits.push({ start: decl.start, end: decl.declaration.start, text: "" });
        } else if (!decl.source) {
          edits.push({ start: decl.start, end: decl.end, text: "" }); // export { a, b }
        } else {
          throw new CellSyntaxError("re-exports (export ... from) are not supported in a cell");
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        const decl = node as ExportDefaultNode;
        const anonymous = (decl.declaration.type === "FunctionDeclaration" || decl.declaration.type === "ClassDeclaration") &&
          (decl.declaration as Node & { id: unknown }).id === null;
        // An anonymous `function () {}` or `class {}` isn't a statement on
        // its own; parenthesized, it's an expression and the cell's result (#143).
        edits.push({ start: decl.start, end: decl.declaration.start, text: anonymous ? "(" : "" });
        if (anonymous) edits.push({ start: decl.declaration.end, end: decl.declaration.end, text: ");" });
        break;
      }
      case "ExportAllDeclaration":
        throw new CellSyntaxError("re-exports (export * from) are not supported in a cell");
    }
  });

  // Nested edits can't occur (imports/exports are top level, import()'s
  // keyword edit doesn't overlap its arguments), so apply back to front.
  return applyEdits(js, edits);
}

function newlines(text: string): number {
  let count = 0;
  for (const char of text) if (char === "\n") count++;
  return count;
}

function applyEdits(js: string, edits: Edit[]): string {
  // Back to front; at a shared start, a replacement goes before an insertion.
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = js;
  for (const edit of edits) {
    // Keep every later line where it was, so a cell's lines still map to
    // esbuild's (the debugger relies on it, #18): a multi-line import
    // rewritten to one line is padded with the newlines it replaced.
    const lost = newlines(js.slice(edit.start, edit.end)) - newlines(edit.text);
    const text = lost > 0 ? edit.text + "\n".repeat(lost) : edit.text;
    out = out.slice(0, edit.start) + text + out.slice(edit.end);
  }
  return out;
}

/** Adds the names a binding pattern declares. */
function patternNames(pattern: Pattern, names: Set<string>): void {
  switch (pattern.type) {
    case "Identifier":
      names.add(pattern.name);
      break;
    case "ObjectPattern":
      for (const prop of pattern.properties) patternNames(prop.type === "Property" ? prop.value : prop, names);
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) if (element) patternNames(element, names);
      break;
    case "RestElement":
      patternNames(pattern.argument, names);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, names);
      break;
  }
}

/**
 * Makes a cell's declarations global without replMode, the tslab/IJavascript
 * technique: the cell runs inside an async function (for top-level await),
 * and every name it declares at the top level is declared with `var` in the
 * surrounding script, which a global-code eval turns into a property of
 * globalThis. Inside the function the declarations become assignments to
 * those globals:
 *   const { a } = o; class K {}  ->  var a, K; (async () => {
 *                                    ({ a } = o); K = class K {}; })()
 * So later cells, and closures from this one, all see one binding. A `var`
 * in a top-level block or loop head is global too, as in a script; block
 * scoped and function-local declarations stay where they are. Functions
 * keep their in-cell hoisting and are copied to globalThis on entry.
 *
 * A trailing expression statement becomes `return [value]`; the box keeps a
 * promise from being awaited, so the cell's result is the promise itself, as
 * in Deno.
 */
function hoistForEval(js: string): string {
  const program = parseCell(js);
  const names = new Set<string>();
  const functions: string[] = [];
  const edits: Edit[] = [];
  const src = (node: Node) => js.slice(node.start, node.end);
  const replace = (node: Node, text: string) => edits.push({ start: node.start, end: node.end, text });

  // A declarator without an initializer resets the name, except under var,
  // where redeclaring keeps the value.
  const assignments = (decl: VariableDeclaration): string[] =>
    decl.declarations.flatMap((d) => {
      patternNames(d.id, names);
      if (d.init) return [`${src(d.id)} = ${src(d.init)}`];
      return decl.kind === "var" ? [] : [`${src(d.id)} = undefined`];
    });
  const statement = (decl: VariableDeclaration) => {
    const parts = assignments(decl);
    replace(decl, parts.length > 0 ? `(${parts.join(", ")});` : ";");
  };
  const isVar = (node: Node | null | undefined): node is VariableDeclaration =>
    node?.type === "VariableDeclaration" && (node as VariableDeclaration).kind === "var";
  const loopHead = (left: Node) => {
    if (!isVar(left)) return;
    const id = left.declarations[0].id;
    patternNames(id, names);
    replace(left, src(id));
  };
  // Expressions can't hold statements outside a function or class, so only
  // statement bodies are walked.
  const nestedVars = (node: Node) =>
    recursive(node, null, {
      Function() {},
      Class() {},
      VariableDeclaration(decl) {
        if (decl.kind === "var") statement(decl);
      },
      ForStatement(loop, state, walk) {
        if (isVar(loop.init)) replace(loop.init, assignments(loop.init).join(", "));
        walk(loop.body, state);
      },
      ForInStatement(loop, state, walk) {
        loopHead(loop.left);
        walk(loop.body, state);
      },
      ForOfStatement(loop, state, walk) {
        loopHead(loop.left);
        walk(loop.body, state);
      },
    });

  program.body.forEach((stmt, i) => {
    if (stmt.type === "VariableDeclaration" && (stmt.kind === "var" || stmt.kind === "let" || stmt.kind === "const")) {
      statement(stmt);
    } else if (stmt.type === "FunctionDeclaration") {
      names.add(stmt.id.name);
      functions.push(stmt.id.name);
    } else if (stmt.type === "ClassDeclaration") {
      names.add(stmt.id.name);
      edits.push({ start: stmt.start, end: stmt.start, text: `${stmt.id.name} = ` });
      edits.push({ start: stmt.end, end: stmt.end, text: ";" });
    } else if (stmt.type === "ExpressionStatement" && i === program.body.length - 1) {
      // Parenthesized, so `1, 2` returns [2] rather than [1, 2] (#140).
      replace(stmt, `return [(${src(stmt.expression)})];`);
    } else {
      nestedVars(stmt);
    }
  });

  // All on the first line, so the cell always starts on line 2, as after
  // transformCell's one-line prelude (#150).
  const declare = names.size > 0 ? `var ${[...names].join(", ")}; ` : "";
  const publish = functions.map((name) => ` globalThis.${name} = ${name};`).join("");
  return `${declare}(async () => { 'use strict';${publish}\n${applyEdits(js, edits)}\n})()`;
}

export function transformCell(code: string, options: CellTransformOptions = {}): string {
  return PRELUDE + rewriteModuleSyntax(stripTypes(code, options)) + SETTLE;
}

/**
 * transformCell, plus the map between the cell's lines and the script's,
 * for the debugger (#18). The rewrite keeps lines (see applyEdits), so the
 * script's lines are the stripper's, after the prelude's one.
 */
export function transformCellWithLines(code: string, options: CellTransformOptions = {}): { script: string; lines: LineMap } {
  const stripped = stripTypesMapped(code, options, true);
  return { script: PRELUDE + rewriteModuleSyntax(stripped.code) + SETTLE, lines: new LineMap(stripped.mappings, newlines(PRELUDE), stripped.code) };
}

/**
 * Like transformCell, for a target that evaluates cells itself, as global
 * code (an indirect eval), instead of through the inspector's replMode: see
 * hoistForEval. The script's value is a promise of the boxed result.
 */
export function transformCellForEval(code: string, options: CellTransformOptions = {}): string {
  return hoistForEval(rewriteModuleSyntax(stripTypes(code, options)));
}

/**
 * Deno treats a cell like `{ "a": 1 }` as an object literal rather than a
 * block, as browser consoles do. Returns the wrapped form to try first, or
 * null when no wrapping applies.
 */
export function objectLiteralCandidate(code: string): string | null {
  return code.trimStart().startsWith("{") && !code.trimEnd().endsWith(";") ? `(${code})` : null;
}
