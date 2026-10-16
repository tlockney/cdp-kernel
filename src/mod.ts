/**
 * cdp-kernel: a Jupyter kernel for TypeScript and JavaScript, extracted from
 * Deno's, that runs notebooks on several JavaScript runtimes. The kernel host
 * runs on Node or Deno; cells run in a separate target runtime: Node or Deno
 * over the Chrome DevTools Protocol, or Bun, workerd and celld, which
 * evaluate cells in-process.
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
