// Turns a notebook cell (TypeScript/TSX, ES module syntax) into a script that
// CDP's Runtime.evaluate can run with replMode: true.
//
// Deno does this with deno_ast (swc) and `var_decl_imports: true`
// (cli/tools/repl/session.rs, evaluate_ts_expression). Here esbuild does the
// TypeScript/JSX part and acorn finds the module syntax that a script can't
// contain:
//   import x, { y as z } from "m"  ->  var __cdpk_m0 = await __cdpk.import("m");
//                                     var x = __cdpk_m0.default, z = __cdpk_m0.y;
//   import("m")                    ->  __cdpk.import("m")
//   import.meta                    ->  __cdpk.meta
//   export const a = 1             ->  const a = 1
// `__cdpk` is installed in the target by runtime/bootstrap.mjs. Routing
// import() through it matters: code evaluated over the inspector has no
// module referrer, so Node rejects a bare import() ("A dynamic import
// callback was not specified").

import { transformSync } from "esbuild";
import { parse, type Node } from "acorn";
import { full } from "acorn-walk";

export const SHIM = "__cdpk";

// Each cell first yields one macrotask. User code then runs as an ordinary
// task instead of nested inside the inspector's dispatch of Runtime.evaluate,
// which is what lets a Runtime.terminateExecution from the control session
// interrupt a busy loop. (Within that dispatch the inspector processes no
// other messages, so an interrupt would never be seen.)
const PRELUDE = `'use strict'; await ${SHIM}.tick();\n`;

export class CellSyntaxError extends Error {
  override name = "SyntaxError";
}

function stripTypes(code: string): string {
  // Like Deno: prefer TSX, fall back to TS for `<T>x` assertions.
  let firstError: unknown;
  for (const loader of ["tsx", "ts"] as const) {
    try {
      return transformSync(code, {
        loader,
        target: "esnext",
        jsx: "transform",
        tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
        logLevel: "silent",
      }).code;
    } catch (err) {
      firstError ??= err;
    }
  }
  const message = firstError instanceof Error ? firstError.message : String(firstError);
  throw new CellSyntaxError(message.replace(/^Transform failed with \d+ errors?:\n/, ""));
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
  if (node.specifiers.length === 0) return `${load};`;
  const ns = `${SHIM}_m${index}`;
  const bindings = node.specifiers.map((spec) => {
    const local = String(spec.local.name);
    if (spec.type === "ImportNamespaceSpecifier") return `${local} = ${ns}`;
    return `${local} = ${ns}[${JSON.stringify(importedName(spec))}]`;
  });
  return `var ${ns} = ${load}; var ${bindings.join(", ")};`;
}

/** Rewrites module-only syntax in plain JavaScript into script syntax. */
export function rewriteModuleSyntax(js: string): string {
  let program: Node;
  try {
    program = parse(js, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: false,
    });
  } catch (err) {
    throw new CellSyntaxError(err instanceof Error ? err.message : String(err));
  }

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
        edits.push({ start: decl.start, end: decl.declaration.start, text: "" });
        break;
      }
      case "ExportAllDeclaration":
        throw new CellSyntaxError("re-exports (export * from) are not supported in a cell");
    }
  });

  // Nested edits can't occur (imports/exports are top level, import()'s
  // keyword edit doesn't overlap its arguments), so apply back to front.
  edits.sort((a, b) => b.start - a.start);
  let out = js;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

export function transformCell(code: string): string {
  return PRELUDE + rewriteModuleSyntax(stripTypes(code));
}

/**
 * Deno treats a cell like `{ "a": 1 }` as an object literal rather than a
 * block, as browser consoles do. Returns the wrapped form to try first, or
 * null when no wrapping applies.
 */
export function objectLiteralCandidate(code: string): string | null {
  return code.trimStart().startsWith("{") && !code.trimEnd().endsWith(";") ? `(${code})` : null;
}
