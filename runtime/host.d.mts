import type { CommApi } from "./comm.d.mts";

/** The target name of the comm a Ganymede server opens to the kernel. */
export const HOST_TARGET: "ganymede.host.v1";

/** Why a host call failed. The codes are ganymede-device's. */
export type HostErrorCode = "unavailable" | "denied" | "cancelled" | "timeout" | "failed" | "disconnected";

/**
 * A failed host call. Branch on `code` (or `name === "HostError"`): the
 * class isn't a global, so `instanceof` isn't available in a cell.
 *
 * A failed host call: `unavailable` (no such method), `denied` (not
 * granted to this notebook), `cancelled` (its signal aborted), `timeout`,
 * `failed` (the server couldn't do it), `disconnected` (the host comm
 * closed, such as on a server restart).
 */
export class HostError extends Error {
  readonly code: HostErrorCode;
  constructor(code: HostErrorCode, message: string);
  static from(err: unknown): HostError;
}

/** Options for a host call. */
export interface HostCallOptions {
  /** Aborting it cancels the call. Default `jupyter.signal`. */
  signal?: AbortSignal;
}

/** Parameters and results are JSON; the host API's design note lists each method's. */
export type HostParams = { [key: string]: unknown };

/** An entry `notebooks.list` returns: a folder, or a notebook this notebook may read. */
export interface NotebookEntry {
  path: string;
  type: "directory" | "notebook";
  /** Its first heading, for a notebook that has one. */
  title?: string | null;
  /** Its kernelspec name. */
  kernel?: string | null;
  /** ISO 8601. */
  modified: string;
}

/** A cell `notebooks.search` matched. */
export interface NotebookHit {
  path: string;
  title: string | null;
  /** The cell's position in the notebook. */
  index: number;
  id: string | null;
  cell_type: "code" | "markdown" | "raw";
  /** Where the first word matched. */
  in: "source" | "output";
  excerpt: string;
}

/** What `notebooks.search` returns. */
export interface NotebookSearch {
  hits: NotebookHit[];
  /** Matching cells, beyond `limit` too. */
  total: number;
  truncated: boolean;
}

/** The Ganymede server that runs this kernel, from `jupyter.host()`. */
export interface Host {
  /** The host API's protocol version. */
  readonly protocol: number;
  /** The server's version. */
  readonly server: string;
  /** This notebook's path under the server's root, or null when the kernel has none. */
  readonly notebook: string | null;
  /** The methods this notebook may call. */
  readonly methods: readonly string[];
  /**
   * Whether this notebook may call `method`.
   *
   * @param method The method, such as `"notebooks.run"`.
   * @example
   * ```ts
   * const host = await jupyter.host();
   * host?.has("notebooks.run"); // false unless the notebook is granted runs
   * ```
   */
  has(method: string): boolean;
  /**
   * Call a method by name. The shortcuts under `notebooks` and `self` call
   * this.
   *
   * @param method The method, such as `"notebooks.read"`.
   * @param params Its parameters, a JSON object. Default `{}`.
   * @param options `signal` cancels the call.
   * @returns What the server answered, as JSON.
   * @throws {HostError} The call failed; `code` says why.
   * @example
   * ```ts
   * const host = await jupyter.host();
   * const { notebook } = await host!.call("notebooks.read", { path: "journal/a.ipynb" });
   * notebook.cells.length;
   * ```
   */
  call(method: string, params?: HostParams, options?: HostCallOptions): Promise<any>;
  /** Other notebooks under the server's root, as far as this notebook's grant reaches. */
  readonly notebooks: HostNotebooks;
  /** This notebook's own cells. Not on a server yet: they reject `unavailable`. */
  readonly self: HostSelf;
}

/** `host.notebooks`: other notebooks under the server's root. */
export interface HostNotebooks {
  /**
   * The notebooks this notebook may read, and the folders, in a folder.
   *
   * @param params `dir`: the folder, relative to the root. Default the root.
   * @param options `signal` cancels the call.
   * @returns One entry per notebook or folder.
   * @throws {HostError} `denied` when the grant doesn't reach `dir`.
   * @example
   * ```ts
   * const host = await jupyter.host();
   * const entries = await host!.notebooks.list({ dir: "journal" });
   * entries.filter((e) => e.type === "notebook").map((e) => e.title ?? e.path);
   * ```
   */
  list(params?: { dir?: string }, options?: HostCallOptions): Promise<NotebookEntry[]>;
  /**
   * A notebook as nbformat JSON (from its open document when someone has
   * it open), and each cell's source hash by cell id.
   *
   * @param params `path`: the notebook, relative to the root.
   * @param options `signal` cancels the call.
   * @returns The notebook and its hashes.
   * @throws {HostError} `denied` when the grant doesn't reach `path`.
   * @example
   * ```ts
   * const host = await jupyter.host();
   * const { notebook } = await host!.notebooks.read({ path: "journal/a.ipynb" });
   * notebook.cells.length;
   * ```
   */
  read(params: { path: string }, options?: HostCallOptions): Promise<{ notebook: any; hashes: { [cellId: string]: string } }>;
  /**
   * Cells that hold every word of `query`, in the notebooks this notebook
   * may read: in sources, and in outputs too with `outputs: true`.
   *
   * @param params `query`, and optionally `dir`, `outputs`, `cell_type`
   *   (`code`, `markdown` or `raw`) and `limit` (default 20, at most 200).
   * @param options `signal` cancels the call.
   * @returns The matches, how many there are in all, and whether `limit` cut them.
   * @example
   * ```ts
   * const host = await jupyter.host();
   * const { hits } = await host!.notebooks.search({ query: "weekday drop", dir: "journal" });
   * hits.map((h) => `${h.path}: ${h.excerpt}`);
   * ```
   */
  search(
    params: { query: string; dir?: string; outputs?: boolean; cell_type?: "code" | "markdown" | "raw"; limit?: number },
    options?: HostCallOptions,
  ): Promise<NotebookSearch>;
  /**
   * A notebook's named results. Not on a server yet: rejects `unavailable`.
   *
   * @param params `path`: the notebook.
   * @param options `signal` cancels the call.
   * @example
   * ```ts
   * const host = await jupyter.host();
   * const results = await host!.notebooks.results({ path: "journal/fremont.ipynb" });
   * ```
   */
  results(params: { path: string }, options?: HostCallOptions): Promise<any>;
  /**
   * Run a notebook with parameters and return its results. Not on a
   * server yet: rejects `unavailable`.
   *
   * @param params `path`: the notebook; `params`: its parameters.
   * @param options `signal` cancels the run.
   * @example
   * ```ts
   * const host = await jupyter.host();
   * const run = await host!.notebooks.run({ path: "journal/fremont.ipynb", params: { counter: "2nd Ave" } });
   * ```
   */
  run(params: { path: string; params?: HostParams }, options?: HostCallOptions): Promise<any>;
}

/** `host.self`: this notebook's own cells. Not on a server yet: each rejects `unavailable`. */
export interface HostSelf {
  /**
   * Add a cell to this notebook.
   *
   * @param params The cell, as the host API's design note describes.
   * @param options `signal` cancels the call.
   * @example
   * ```ts
   * const host = await jupyter.host();
   * await host!.self.add({ cell_type: "markdown", source: "## Index" });
   * ```
   */
  add(params?: HostParams, options?: HostCallOptions): Promise<any>;
  /**
   * Change a cell's source, given the hash of the source it replaces.
   *
   * @param params The cell id, its new source and the old source's hash.
   * @param options `signal` cancels the call.
   * @example
   * ```ts
   * const host = await jupyter.host();
   * const { notebook, hashes } = await host!.notebooks.read({ path: host!.notebook! });
   * const id = notebook.cells[0].id;
   * await host!.self.edit({ id, source: "# New title", source_hash: hashes[id] });
   * ```
   */
  edit(params?: HostParams, options?: HostCallOptions): Promise<any>;
  /**
   * Delete a cell, given its source's hash.
   *
   * @param params The cell id and its source's hash.
   * @param options `signal` cancels the call.
   * @example
   * ```ts
   * const host = await jupyter.host();
   * const { notebook, hashes } = await host!.notebooks.read({ path: host!.notebook! });
   * const id = notebook.cells.at(-1).id;
   * await host!.self.delete({ id, source_hash: hashes[id] });
   * ```
   */
  delete(params?: HostParams, options?: HostCallOptions): Promise<any>;
}

/** Options for `jupyter.host()`. */
export interface HostOptions {
  /**
   * How long to wait for a server that hasn't opened the comm, in ms.
   * Default 1000. Once a wait goes unanswered, later calls answer `null`
   * at once.
   */
  timeout?: number;
}

export function createHost(
  comms: CommApi,
  defaultSignal?: () => AbortSignal | undefined,
): { host(options?: HostOptions): Promise<Host | null> };
