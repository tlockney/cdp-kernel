import type { CommApi } from "./comm.d.mts";

/** The target name of the comm a Ganymede server opens to the kernel. */
export const HOST_TARGET: "ganymede.host.v1";

/** Why a host call failed. The codes are ganymede-device's. */
export type HostErrorCode = "unavailable" | "denied" | "cancelled" | "timeout" | "failed" | "disconnected";

/**
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

/** A call bound to one method. */
export type HostMethod<P = HostParams, R = any> = (params?: P, options?: HostCallOptions) => Promise<R>;

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
  readonly notebooks: {
    /** `{ dir? }`: the notebooks and folders in `dir`, by default the root. */
    readonly list: HostMethod<{ dir?: string }, NotebookEntry[]>;
    /** `{ path }`: its nbformat JSON, and each cell's source hash by cell id. */
    readonly read: HostMethod<{ path: string }, { notebook: any; hashes: { [cellId: string]: string } }>;
    /**
     * `{ query, dir?, outputs?, cell_type?, limit? }`: cells holding every
     * word of `query`, in sources, and in outputs with `outputs: true`.
     */
    readonly search: HostMethod<
      { query: string; dir?: string; outputs?: boolean; cell_type?: "code" | "markdown" | "raw"; limit?: number },
      NotebookSearch
    >;
    /** `{ path }`: its named results. */
    readonly results: HostMethod;
    /** `{ path, params? }`: run it and return its results. */
    readonly run: HostMethod;
  };
  /** This notebook's own cells. */
  readonly self: {
    readonly add: HostMethod;
    readonly edit: HostMethod;
    readonly delete: HostMethod;
  };
}

/** Options for `jupyter.host()`. */
export interface HostOptions {
  /** How long to wait for a server that hasn't opened the comm, in ms. Default 1000. */
  timeout?: number;
}

export function createHost(
  comms: CommApi,
  defaultSignal?: () => AbortSignal | undefined,
): { host(options?: HostOptions): Promise<Host | null> };
