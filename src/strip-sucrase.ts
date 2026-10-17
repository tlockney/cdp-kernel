// A type stripper in plain JavaScript, for a kernel host that can't run
// esbuild's native binary or WebAssembly (#234). sucrase is an optional
// dependency, imported only when a kernel picks it (see loadTypeStripper).
//
// sucrase removes types without parsing them fully or lowering anything,
// and keeps every line where it was. What it leaves alone, a cell can't
// use: decorators and `accessor` fields (which acorn and V8 don't parse
// yet, #142) and namespaces with values (which it drops), so those are
// rejected here with a clear error.

import { parse } from "acorn";
import { type Options, transform } from "sucrase";
import { CellSyntaxError, type CellTransformOptions, type TypeStripper } from "./transform.ts";

const FILE = "cell.tsx";

function jsxSettings(options: CellTransformOptions): Omit<Options, "transforms"> {
  const jsx = options.jsx;
  if (jsx?.mode === "automatic") {
    return { jsxRuntime: "automatic", jsxImportSource: jsx.importSource, production: !jsx.development };
  }
  return {
    jsxRuntime: "classic",
    jsxPragma: jsx?.factory ?? "React.createElement",
    jsxFragmentPragma: jsx?.fragment ?? "React.Fragment",
    production: true,
  };
}

// A namespace that isn't `declare`d: sucrase drops it, values and all.
const NAMESPACE = /^[ \t]*(?:export\s+)?(?:namespace|module)\s+[\w$.]+\s*\{/m;

/** A clearer error than acorn's for syntax sucrase leaves in the output. */
function unsupported(js: string): string | null {
  if (!js.includes("@") && !js.includes("accessor")) return null;
  try {
    parse(js, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true });
    return null;
  } catch (err) {
    const pos = (err as { pos?: unknown }).pos;
    if (typeof pos !== "number") return null;
    if (js[pos] === "@") return "decorators are not supported with the sucrase type stripper";
    if (/\baccessor\s*$/.test(js.slice(0, pos))) return "accessor fields are not supported with the sucrase type stripper";
    return null;
  }
}

export const stripTypes: TypeStripper = (code, options, sourcemap) => {
  if (NAMESPACE.test(code)) {
    throw new CellSyntaxError(
      "namespaces are not supported with the sucrase type stripper; use declare namespace for types only",
    );
  }
  // Like the esbuild stripper: prefer TSX, fall back to TS for `<T>x`
  // assertions.
  let firstError: unknown;
  for (const transforms of [["typescript", "jsx"], ["typescript"]] as const) {
    try {
      const result = transform(code, {
        transforms: [...transforms],
        ...jsxSettings(options),
        // As verbatimModuleSyntax: only `import type` goes.
        keepUnusedImports: true,
        disableESTransforms: true,
        filePath: FILE,
        ...(sourcemap ? { sourceMapOptions: { compiledFilename: FILE } } : {}),
      });
      const reason = unsupported(result.code);
      if (reason !== null) throw new CellSyntaxError(reason);
      return { code: result.code, mappings: result.sourceMap?.mappings ?? "" };
    } catch (err) {
      if (err instanceof CellSyntaxError) throw err;
      firstError ??= err;
    }
  }
  const message = firstError instanceof Error ? firstError.message : String(firstError);
  throw new CellSyntaxError(message.replace(`Error transforming ${FILE}: `, ""));
};
