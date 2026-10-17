// The default type stripper: esbuild. Loaded by loadTypeStripper (see
// src/transform.ts) only when a kernel uses it, so a host that can't run
// esbuild's native binary never imports it (#238).

import { type TransformOptions, transformSync } from "esbuild";
import { CellSyntaxError, type JsxOptions, type TypeStripper } from "./transform.ts";

function jsxSettings(jsx: JsxOptions | undefined): TransformOptions {
  if (jsx?.mode === "automatic") {
    return { jsx: "automatic", jsxImportSource: jsx.importSource, jsxDev: jsx.development };
  }
  return { jsx: "transform", jsxFactory: jsx?.factory, jsxFragment: jsx?.fragment };
}

export const stripTypes: TypeStripper = (code, options, sourcemap) => {
  const compilerOptions = {
    verbatimModuleSyntax: true,
    ...(options.experimentalDecorators ? { experimentalDecorators: true } : {}),
  };
  // Like Deno: prefer TSX, fall back to TS for `<T>x` assertions.
  let firstError: unknown;
  for (const loader of ["tsx", "ts"] as const) {
    try {
      const result = transformSync(code, {
        loader,
        target: "esnext",
        // Neither acorn nor V8 parses standard (TC39) decorators or
        // `accessor` yet, so esbuild lowers them (#142).
        supported: { decorators: false },
        ...jsxSettings(options.jsx),
        tsconfigRaw: { compilerOptions },
        logLevel: "silent",
        ...(sourcemap ? { sourcemap: "external" as const } : {}),
      });
      const map: unknown = sourcemap ? JSON.parse(result.map) : null;
      const mappings = typeof (map as { mappings?: unknown } | null)?.mappings === "string"
        ? (map as { mappings: string }).mappings
        : "";
      return { code: result.code, mappings };
    } catch (err) {
      firstError ??= err;
    }
  }
  const message = firstError instanceof Error ? firstError.message : String(firstError);
  throw new CellSyntaxError(message.replace(/^Transform failed with \d+ errors?:\n/, ""));
};
