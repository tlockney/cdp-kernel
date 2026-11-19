// The kernel's side of typed completion and inspection on Node (#273,
// #274): starts the language-service worker thread
// (src/language-service-worker.ts) on the first request. The requests,
// time budget and idle shutdown are LanguageClient's (src/language-client.ts),
// which a page's kernel uses with a Web Worker (#524).

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { LanguageClient, type WorkerHandle } from "./language-client.ts";

export type {
  CellDiagnostic,
  CellEdit,
  CellSpan,
  CompletionEntry,
  CompletionResult,
  RenameResult,
  SignatureHelp,
} from "./notebook-types.ts";
export type { Result, WorkerRequest, WorkerResponse } from "./language-client.ts";

/** What the worker is started with. */
export interface WorkerOptions {
  notebookDir: string;
  /** See NotebookTypesOptions.npmCache. */
  npmCache: "npm" | "bun" | null;
  /** A Deno target: resolve imports with `deno info`, under this project config if any. */
  deno: { config: string | null } | null;
  /** Add `deno types` (the Deno namespace) to the globals. */
  denoTypes: boolean;
  /** Declaration files for the target's globals, e.g. a Workers project's worker-configuration.d.ts. */
  typeFiles: string[];
  /** runtime/display.mjs, which types `jupyter`; null if not a local file. */
  display: string | null;
  /** Type packages for the target's globals, e.g. @types/node. */
  typePackages: { name: string; range: string }[];
  /** Globals the target has but no types for, e.g. `Deno` on a --deno-compat Node: declared `any`. */
  untypedGlobals?: string[];
}

// Compiled to dist/*.js for the npm package, run as .ts from a checkout.
const WORKER_URL = new URL(
  import.meta.url.endsWith(".ts") ? "./language-service-worker.ts" : "./language-service-worker.js",
  import.meta.url,
);
const DISPLAY_URL = new URL("../runtime/display.mjs", import.meta.url);

/**
 * What to start the worker from. Deno's node:worker_threads takes only
 * file: and data: URLs, so a kernel run from JSR (https:) starts a data:
 * module that imports the worker.
 */
export function workerEntry(url: URL = WORKER_URL): URL {
  if (url.protocol === "file:") return url;
  return new URL(`data:text/javascript,${encodeURIComponent(`import ${JSON.stringify(url.href)};`)}`);
}

/** The language service in a worker thread. */
export class LanguageService extends LanguageClient {
  constructor(
    options: Omit<WorkerOptions, "display">,
    { budgetMs, log }: { budgetMs?: number; log?: (text: string) => void } = {},
  ) {
    const workerOptions: WorkerOptions = { ...options, display: DISPLAY_URL.protocol === "file:" ? fileURLToPath(DISPLAY_URL) : null };
    super({ budgetMs, log, start: () => startWorker(workerOptions) });
  }
}

function startWorker(options: WorkerOptions): WorkerHandle {
  const worker = new Worker(workerEntry(), { workerData: options });
  // An idle worker mustn't keep the kernel alive.
  worker.unref();
  return {
    postMessage: (message) => worker.postMessage(message),
    onMessage: (listener) => worker.on("message", listener),
    onError: (listener) => worker.on("error", listener),
    onExit: (listener) => worker.on("exit", listener),
    terminate: () => void worker.terminate(),
  };
}
