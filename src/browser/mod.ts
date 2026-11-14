// cdp-kernel in a browser page: the kernel's message handling
// (src/kernel-core.ts) on the page, and cells in a Web Worker
// (runtime/browser-worker.mjs, via src/browser/target.ts).
//
//   import { startBrowserKernel } from "@tlockney/cdp-kernel/browser";
//   const kernel = startBrowserKernel({
//     createWorker: () => new Worker(new URL("./worker.js", import.meta.url), { type: "module" }),
//   });
//   kernel.onMessage((channel, msg) => console.log(channel, msg.header.msg_type));
//   kernel.send("shell", executeRequest);

import { KernelCore } from "../kernel-core.ts";
import type { JsonObject } from "../message.ts";
import type { TypeStripper, TypeStripperName } from "../transform.ts";
// The browser build (scripts/build-browser.mjs) swaps package.ts, which
// imports Node, for its VERSION alone.
import { VERSION } from "../package.ts";
import { type Channel, type JupyterMessage, type MessageListener, PageChannels } from "./channels.ts";
import { BrowserTarget, type BrowserTargetOptions } from "./target.ts";

export type { Channel, JupyterMessage, MessageListener } from "./channels.ts";
export { BrowserTarget, type BrowserTargetOptions, type HostHandler, type HostRequest, type WorkerLike } from "./target.ts";

/**
 * The packages `jupyter.chart` imports, as it writes them: map them in
 * `modules` to copies the page serves, and charts draw offline. The page
 * serves ES modules that export what the packages do. Same as
 * runtime/chart.mjs's VEGA, VEGA_LITE and LINKEDOM.
 */
export const CHART_MODULES = {
  vega: "npm:vega@6",
  vegaLite: "npm:vega-lite@6",
  linkedom: "npm:linkedom@0.18",
} as const;

/**
 * What `jupyter.sql` loads, as it writes them: map them in `modules` to
 * copies the page serves, and SQL runs offline. `duckdb` is an ES module
 * that exports what @duckdb/duckdb-wasm does; the others are that
 * package's own dist files, served as they are. A page may map only the
 * `eh` pair (every current browser runs it); a variant left unmapped
 * loads from jsDelivr. Same as runtime/sql.mjs's DUCKDB_WASM and
 * DUCKDB_FILES.
 */
export const SQL_MODULES = {
  duckdb: "npm:@duckdb/duckdb-wasm@1.29.0",
  ehWasm: "npm:@duckdb/duckdb-wasm@1.29.0/dist/duckdb-eh.wasm",
  ehWorker: "npm:@duckdb/duckdb-wasm@1.29.0/dist/duckdb-browser-eh.worker.js",
  mvpWasm: "npm:@duckdb/duckdb-wasm@1.29.0/dist/duckdb-mvp.wasm",
  mvpWorker: "npm:@duckdb/duckdb-wasm@1.29.0/dist/duckdb-browser-mvp.worker.js",
} as const;

export interface BrowserKernelOptions extends BrowserTargetOptions {
  /** What strips cells' types; sucrase by default, since esbuild's native binary can't run in a page. */
  typeStrip?: TypeStripperName | TypeStripper;
  /** Where the kernel's own log lines go; console.debug by default. */
  log?(text: string): void;
  /** Returned as `capabilities` in kernel_info_reply: what this page offers cells (#384). */
  capabilities?: JsonObject;
}

export interface BrowserKernel {
  /** A message from the frontend, on shell, control or stdin. */
  send(channel: Exclude<Channel, "iopub">, msg: JupyterMessage): void;
  /** Every message the kernel sends, with its channel. Returns a function that stops listening. */
  onMessage(listener: MessageListener): () => void;
  /** Settles once a shutdown_request has been answered. */
  readonly closed: Promise<void>;
  /** An event for the Worker's `host.onEvent` listeners; dropped while no Worker runs (#384). */
  notifyHost(event: string, value?: unknown): void;
}

export function startBrowserKernel(options: BrowserKernelOptions): BrowserKernel {
  const channels = new PageChannels();
  const log = options.log ?? ((text: string) => console.debug(`[cdp-kernel] ${text}`));
  let closed!: () => void;
  const closedPromise = new Promise<void>((resolve) => (closed = resolve));
  let target: BrowserTarget | null = null;
  const core = new KernelCore({
    runtime: "browser",
    version: VERSION,
    channels,
    launchTarget: async (events) => (target = await BrowserTarget.launch(events, options)),
    typeStrip: options.typeStrip ?? "sucrase",
    capabilities: options.capabilities,
    log,
    exit: () => closed(),
  });
  core.run().catch((err) => log(`kernel stopped: ${err instanceof Error ? err.stack : err}`));
  return {
    send: (channel, msg) => channels.deliver(channel, msg),
    onMessage: (listener) => channels.onMessage(listener),
    closed: closedPromise,
    notifyHost: (event, value) => target?.notifyHost(event, value),
  };
}
