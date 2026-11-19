// What a language-service worker does with the client's requests
// (src/language-client.ts), the same in a Node worker thread
// (src/language-service-worker.ts) and a page's Web Worker
// (src/browser/language-worker.ts, #524): holds the cells that arrive
// before TypeScript has loaded, answers null until it has, and answers the
// requests that need the target's type packages with null until they are in.
// No Node imports.

import type { NotebookTypesCore } from "./notebook-types-core.ts";
import type { Result, WorkerRequest, WorkerResponse } from "./language-client.ts";

export class LanguageServer {
  readonly #post: (response: WorkerResponse) => void;
  /** Null until TypeScript is loaded. */
  #types: NotebookTypesCore | null = null;
  /** Cells that ran before TypeScript loaded, replayed to it. */
  #cells: string[] = [];
  /**
   * Type packages still loading, or failed: diagnostics wait for them, as
   * without them a target's globals are errors (#514).
   */
  #typePackagesPending: number;
  #typePackagesFailed = false;

  constructor(post: (response: WorkerResponse) => void, typePackages = 0) {
    this.#post = post;
    this.#typePackagesPending = typePackages;
  }

  /** TypeScript has loaded: the service takes over, after the cells that ran so far. */
  start(types: NotebookTypesCore): void {
    for (const code of this.#cells) types.addCell(code);
    this.#cells = [];
    this.#types = types;
  }

  /** One of the type packages given to the constructor is in, or failed. */
  typePackageDone(failed: boolean): void {
    if (failed) this.#typePackagesFailed = true;
    this.#typePackagesPending--;
  }

  handle(request: WorkerRequest): void {
    const types = this.#types;
    switch (request.type) {
      case "cell":
        if (types === null) this.#cells.push(request.code);
        else types.addCell(request.code);
        return;
      case "reset":
        if (types === null) this.#cells = [];
        else types.reset();
        return;
      case "complete":
      case "quickInfo":
      case "diagnostics":
      case "signature":
      case "definition":
      case "rename":
        if (types === null) {
          this.#post({ id: request.id, result: null });
          return;
        }
        try {
          this.#post({ id: request.id, result: this.#answer(types, request) });
        } catch (err) {
          this.#post({ id: request.id, error: err instanceof Error ? err.stack ?? err.message : String(err) });
        }
    }
  }

  /** The answer to a request for a loaded service. */
  #answer(types: NotebookTypesCore, request: Exclude<WorkerRequest, { type: "cell" | "reset" }>): Result {
    // Without the target's type packages, its globals would be errors and
    // unknown names, so these answer null until they are in (#514, #522).
    const typesReady = this.#typePackagesPending === 0 && !this.#typePackagesFailed;
    switch (request.type) {
      case "complete":
        return types.complete(request.code, request.cursor);
      case "quickInfo":
        return types.quickInfo(request.code, request.cursor);
      case "diagnostics":
        return typesReady ? types.diagnostics(request.code, request.budgetMs) : null;
      case "signature":
        return typesReady ? types.signature(request.code, request.cursor, request.budgetMs) : null;
      case "definition":
        return typesReady ? types.definition(request.cells, request.cell, request.cursor, request.budgetMs) : null;
      case "rename":
        return typesReady ? types.rename(request.cells, request.cell, request.cursor, request.newName, request.budgetMs) : null;
    }
  }
}
