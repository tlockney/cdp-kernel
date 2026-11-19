// The kernel's side of typed completion and inspection (#273, #274), apart
// from how a worker is started (#524): keeps a language-service worker fed
// with executed cells, gives each request a time budget, after which the
// kernel answers from the runtime alone, and ends the worker after a while
// without requests, which gives its memory back (about 150 MB). A Node
// worker thread (src/language-service.ts) and a page's Web Worker
// (src/browser/mod.ts) both run it. No Node imports.

import type { CellDiagnostic, CellSpan, CompletionResult, RenameResult, SignatureHelp } from "./notebook-types-core.ts";

export type WorkerRequest =
  | { type: "cell"; code: string }
  | { type: "reset" }
  | { type: "complete" | "quickInfo"; id: number; code: string; cursor: number }
  | { type: "diagnostics"; id: number; code: string; budgetMs: number }
  | { type: "signature"; id: number; code: string; cursor: number; budgetMs: number }
  | { type: "definition"; id: number; cells: string[]; cell: number; cursor: number; budgetMs: number }
  | { type: "rename"; id: number; cells: string[]; cell: number; cursor: number; newName: string; budgetMs: number };

export type Result = CompletionResult | CellDiagnostic[] | SignatureHelp | CellSpan[] | RenameResult | string | null;

/** A request before it has an id. */
type Query = WorkerRequest extends infer R ? R extends { id: number } ? Omit<R, "id"> : never : never;

export type WorkerResponse =
  | { id: number; result: Result }
  | { id: number; error: string }
  /** TypeScript couldn't be loaded or installed (#513): the worker is of no use. */
  | { unavailable: string }
  /** The TypeScript version the worker loaded (#513). */
  | { loaded: string };

/**
 * How long a request waits for the worker. JupyterLab gives a kernel's
 * completions a second, and the runtime's half runs alongside.
 */
export const BUDGET_MS = 500;
const IDLE_MS = 10 * 60 * 1000;

/** A running worker, as the client uses it: Node's worker_threads Worker or a page's Web Worker. */
export interface WorkerHandle {
  postMessage(message: unknown): void;
  /** Called with each response. */
  onMessage(listener: (response: WorkerResponse) => void): void;
  /** The worker failed, e.g. its script didn't load. */
  onError(listener: (err: unknown) => void): void;
  /** The worker ended. */
  onExit(listener: () => void): void;
  terminate(): void;
}

export interface LanguageClientOptions {
  /** Starts a worker; throws if it can't. */
  start(): WorkerHandle;
  budgetMs?: number;
  log?: (text: string) => void;
}

export class LanguageClient {
  readonly #start: () => WorkerHandle;
  readonly #budgetMs: number;
  readonly #log: (text: string) => void;
  /** Executed cells, replayed to a new worker. */
  readonly #cells: string[] = [];
  readonly #pending = new Map<number, (response: WorkerResponse | null) => void>();
  #worker: WorkerHandle | null = null;
  #nextId = 1;
  #idle: ReturnType<typeof setTimeout> | null = null;
  /** The worker couldn't start: don't keep trying. */
  #broken = false;
  #typescriptVersion: string | undefined;

  constructor({ start, budgetMs = BUDGET_MS, log = () => {} }: LanguageClientOptions) {
    this.#start = start;
    this.#budgetMs = budgetMs;
    this.#log = log;
  }

  /**
   * The TypeScript version a worker loaded, once one has: on a Deno host
   * it may come from Deno's cache, where findTypeScript doesn't look.
   */
  get typescriptVersion(): string | undefined {
    return this.#typescriptVersion;
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
  async complete(code: string, cursor: number): Promise<CompletionResult | null> {
    return (await this.#request({ type: "complete", code, cursor })) as CompletionResult | null;
  }

  /** Type, signature and JSDoc for the name at the cursor, or null. */
  async quickInfo(code: string, cursor: number): Promise<string | null> {
    return (await this.#request({ type: "quickInfo", code, cursor })) as string | null;
  }

  /**
   * Type and syntax errors in `code`, checked against the cells that ran
   * (#514), or null if the service can't tell within the budget.
   */
  async diagnostics(code: string): Promise<CellDiagnostic[] | null> {
    return (await this.#request({ type: "diagnostics", code, budgetMs: this.#budgetMs })) as CellDiagnostic[] | null;
  }

  /**
   * The signature of the call the cursor is in, checked against the cells
   * that ran (#522), or null.
   */
  async signature(code: string, cursor: number): Promise<SignatureHelp | null> {
    return (await this.#request({ type: "signature", code, cursor, budgetMs: this.#budgetMs })) as SignatureHelp | null;
  }

  /**
   * Where the name at `cursor` in `cells[cell]` is declared, among the
   * notebook's cells as the frontend has them (#522); null when unknown.
   */
  async definition(cells: string[], cell: number, cursor: number): Promise<CellSpan[] | null> {
    return (await this.#request({ type: "definition", cells, cell, cursor, budgetMs: this.#budgetMs })) as CellSpan[] | null;
  }

  /** The edits that rename the name at `cursor` across `cells` (#522), or why not; null when unknown. */
  async rename(cells: string[], cell: number, cursor: number, newName: string): Promise<RenameResult | null> {
    return (await this.#request({ type: "rename", cells, cell, cursor, newName, budgetMs: this.#budgetMs })) as RenameResult | null;
  }

  #request(request: Query): Promise<Result> {
    const type = request.type;
    const worker = this.#ensureWorker();
    if (worker === null) return Promise.resolve(null);
    const id = this.#nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(null), this.#budgetMs);
      const settle = (response: WorkerResponse | null) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        if (response !== null && "error" in response) this.#log(`${type} failed: ${response.error}`);
        resolve(response !== null && "result" in response ? response.result : null);
      };
      this.#pending.set(id, settle);
      worker.postMessage({ ...request, id } satisfies WorkerRequest);
    });
  }

  /** Ends the worker; the next request starts another. */
  close(): void {
    if (this.#idle !== null) clearTimeout(this.#idle);
    this.#idle = null;
    const worker = this.#worker;
    this.#worker = null;
    for (const settle of this.#pending.values()) settle(null);
    worker?.terminate();
  }

  #ensureWorker(): WorkerHandle | null {
    if (this.#broken) return null;
    if (this.#idle !== null) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.close(), IDLE_MS);
    // An idle timer mustn't keep a Node kernel alive.
    (this.#idle as { unref?: () => void }).unref?.();
    if (this.#worker !== null) return this.#worker;
    let worker: WorkerHandle;
    try {
      worker = this.#start();
    } catch (err) {
      this.#broken = true;
      this.#log(`typed completion unavailable: ${err instanceof Error ? err.message : err}`);
      return null;
    }
    worker.onMessage((response) => {
      if ("loaded" in response) {
        this.#typescriptVersion = response.loaded;
        return;
      }
      if ("unavailable" in response) {
        // Until the kernel restarts: e.g. offline, so a retry would fail too.
        this.#broken = true;
        this.#log(`typed completion unavailable: ${response.unavailable}`);
        if (this.#worker === worker) this.close();
        return;
      }
      this.#pending.get(response.id)?.(response);
    });
    worker.onError((err) => {
      // E.g. typescript failed to load. Completion goes on from the runtime.
      this.#broken = true;
      this.#log(`typed completion unavailable: ${err instanceof Error ? err.message : err}`);
      if (this.#worker === worker) this.close();
    });
    worker.onExit(() => {
      if (this.#worker === worker) this.close();
    });
    for (const code of this.#cells) worker.postMessage({ type: "cell", code } satisfies WorkerRequest);
    this.#worker = worker;
    return worker;
  }
}
