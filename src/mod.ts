/**
 * cdp-kernel: Deno's Jupyter kernel, extracted to run notebook cells in any
 * runtime whose inspector speaks the Chrome DevTools Protocol (Node and
 * Deno today).
 *
 * Most people want the CLI (`cdp-kernel install`). This module exposes
 * the kernel for embedding: give it a parsed connection file and a target
 * runtime, then await {@link Kernel.run}.
 *
 * @example
 * ```ts
 * import { readFileSync } from "node:fs";
 * import { Kernel, parseConnectionInfo } from "@tlockney/cdp-kernel";
 *
 * const conn = parseConnectionInfo(readFileSync("kernel-123.json", "utf8"));
 * await new Kernel(conn, "node").run();
 * ```
 *
 * @module
 */

export { type ConnectionInfo, Kernel, parseConnectionInfo } from "./kernel.ts";
export type { RuntimeName } from "./target.ts";
export { VERSION } from "./package.ts";
