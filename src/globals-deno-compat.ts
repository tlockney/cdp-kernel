/**
 * Ambient `Deno` namespace for Node notebooks run with `--deno-compat`
 * (kernelspec `cdp-node-deno`), on top of the `jupyter` globals.
 *
 * Opt-in and separate from `./globals` because on a real Deno target, or
 * with Deno's own types loaded, `Deno` is already declared.
 *
 * @module
 */

import type { DenoShim } from "../runtime/deno-compat.mjs";
import type { JupyterNamespace } from "./globals.ts";

export type { DenoShim };

declare global {
  /**
   * The subset of Deno's namespace the compatibility shim implements on Node.
   * APIs outside it (`Deno.serve`, `Deno.Command`, ...) are absent at runtime.
   */
  var Deno: Omit<DenoShim, "jupyter"> & { jupyter: JupyterNamespace };
}
