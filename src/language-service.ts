// The kernel's side of typed completion (#273): starts the language-service
// worker (src/language-service-worker.ts) on the first request, keeps it fed
// with executed cells, and gives each request a time budget, after which
// the kernel answers from the runtime alone. The worker is ended after a
// while without requests, which gives its memory back (about 150 MB).

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { CompletionResult } from "./notebook-types.ts";

export type { CompletionEntry, CompletionResult } from "./notebook-types.ts";

/** What the worker is started with. */
export interface WorkerOptions {
  notebookDir: string;
  npmCache: boolean;
  /** runtime/display.mjs, which types `jupyter`; null if not a local file. */
  display: string | null;
  /** Type packages for the target's globals, e.g. @types/node. */
  typePackages: { name: string; range: string }[];
}

export type WorkerRequest =
  | { type: "cell"; code: string }
  | { type: "reset" }
  | { type: "complete"; id: number; code: string; cursor: number };

export type WorkerResponse = { id: number; result: CompletionResult } | { id: number; error: string };

/**
 * How long a request waits for the worker. JupyterLab gives a kernel's
 * completions a second, and the runtime's half runs alongside.
 */
const BUDGET_MS = 500;
const IDLE_MS = 10 * 60 * 1000;

// Compiled to dist/*.js for the npm package, run as .ts from a checkout.
const WORKER_URL = new URL(
  import.meta.url.endsWith(".ts") ? "./language-service-worker.ts" : "./language-service-worker.js",
  import.meta.url,
);
const DISPLAY_URL = new URL("../runtime/display.mjs", import.meta.url);

export class LanguageService {
  readonly #options: WorkerOptions;
  readonly #budgetMs: number;
  readonly #log: (text: string) => void;
  /** Executed cells, replayed to a new worker. */
  readonly #cells: string[] = [];
  readonly #pending = new Map<number, (response: WorkerResponse | null) => void>();
  #worker: Worker | null = null;
  #nextId = 1;
  #idle: ReturnType<typeof setTimeout> | null = null;
  /** The worker couldn't start: don't keep trying. */
  #broken = false;

  constructor(
    options: Omit<WorkerOptions, "display">,
    { budgetMs = BUDGET_MS, log = () => {} }: { budgetMs?: number; log?: (text: string) => void } = {},
  ) {
    this.#options = { ...options, display: DISPLAY_URL.protocol === "file:" ? fileURLToPath(DISPLAY_URL) : null };
    this.#budgetMs = budgetMs;
    this.#log = log;
  }

  /** A cell that ran (even if it threw): its declarations exist now. */
  addCell(code: string): void {
    this.#cells.push(code);
    this.#worker?.postMessage({ type: "cell", code } satisfies WorkerRequest);
  }

  /** The target restarted, so what the cells declared is gone. */
  reset(): void {
    this.#cells.length = 0;
    this.#worker?.postMessage({ type: "reset" } satisfies WorkerRequest);
  }

  /** Typed completions, or null if the service isn't ready within the budget. */
  complete(code: string, cursor: number): Promise<CompletionResult | null> {
    const worker = this.#ensureWorker();
    if (worker === null) return Promise.resolve(null);
    const id = this.#nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(null), this.#budgetMs);
      const settle = (response: WorkerResponse | null) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        if (response !== null && "error" in response) this.#log(`completion failed: ${response.error}`);
        resolve(response !== null && "result" in response ? response.result : null);
      };
      this.#pending.set(id, settle);
      worker.postMessage({ type: "complete", id, code, cursor } satisfies WorkerRequest);
    });
  }

  /** Ends the worker; the next request starts another. */
  close(): void {
    if (this.#idle !== null) clearTimeout(this.#idle);
    this.#idle = null;
    const worker = this.#worker;
    this.#worker = null;
    for (const settle of this.#pending.values()) settle(null);
    void worker?.terminate();
  }

  #ensureWorker(): Worker | null {
    if (this.#broken) return null;
    if (this.#idle !== null) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.close(), IDLE_MS);
    this.#idle.unref();
    if (this.#worker !== null) return this.#worker;
    let worker: Worker;
    try {
      worker = new Worker(WORKER_URL, { workerData: this.#options });
    } catch (err) {
      this.#broken = true;
      this.#log(`typed completion unavailable: ${err instanceof Error ? err.message : err}`);
      return null;
    }
    // An idle worker mustn't keep the kernel alive.
    worker.unref();
    worker.on("message", (response: WorkerResponse) => this.#pending.get(response.id)?.(response));
    worker.on("error", (err) => {
      // E.g. typescript failed to load. Completion goes on from the runtime.
      this.#broken = true;
      this.#log(`typed completion unavailable: ${err instanceof Error ? err.message : err}`);
      if (this.#worker === worker) this.close();
    });
    worker.on("exit", () => {
      if (this.#worker === worker) this.close();
    });
    for (const code of this.#cells) worker.postMessage({ type: "cell", code } satisfies WorkerRequest);
    this.#worker = worker;
    return worker;
  }
}
