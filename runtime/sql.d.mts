import type { Displayable } from "./display.d.mts";

export const NODE_API: string;
export const DUCKDB_WASM: string;
export interface DuckDBBundle {
  mainModule: string;
  mainWorker: string;
  pthreadWorker?: string | null;
}
export const DUCKDB_FILES: {
  readonly mvp: { readonly mainModule: string; readonly mainWorker: string };
  readonly eh: { readonly mainModule: string; readonly mainWorker: string };
};
export function duckdbBundles(
  jsDelivr: Record<string, DuckDBBundle>,
  mapped?: (specifier: string) => string | null | undefined,
): Record<string, DuckDBBundle>;

/** One column of a query's result. */
export interface SqlColumn {
  name: string;
  /** DuckDB's type name (`BIGINT`, `VARCHAR`, `DATE`), or Arrow's in the browser. */
  type: string;
}

/**
 * A query's result. It shows as a table (the same output as
 * `jupyter.table`) when it is a cell's value or passed to
 * `jupyter.display`.
 */
export interface SqlResult extends Displayable {
  /** The result's columns, in order. */
  readonly columns: SqlColumn[];
  /**
   * The rows as plain objects keyed by column name. Integers that fit a
   * JavaScript number are numbers, larger ones `bigint`; `DATE` and
   * `TIMESTAMP` values are `Date`s.
   */
  readonly rows: Record<string, unknown>[];
}

export const SqlResult: new (columns: SqlColumn[], rows: Record<string, unknown>[]) => SqlResult & {
  toTableSource(names?: string[]): import("./table.d.mts").TableSource;
};

/** Text that `jupyter.sql` puts into the query as written: see `sql.raw`. */
export interface SqlFragment {
  readonly __sqlRaw: never;
}

/**
 * `jupyter.sql`: a tagged template that runs SQL on the kernel's DuckDB.
 * Each `${value}` becomes a bound parameter.
 */
export interface Sql {
  /**
   * Run the query, with each `${value}` as a bound parameter.
   *
   * @example
   * ```ts
   * await jupyter.sql`select ${"Ganymede"} as moon`;
   * ```
   */
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlResult>;
  /**
   * Run SQL from a string, with values for its `?` parameters. For a
   * query built at run time; prefer the tag otherwise.
   *
   * @param text The SQL.
   * @param params Values for its `?` placeholders, in order.
   * @example
   * ```ts
   * const op = ">";
   * await jupyter.sql.query(`select 2 ${op} ? as answer`, [1]);
   * ```
   */
  query(text: string, params?: unknown[]): Promise<SqlResult>;
  /**
   * Text the tag puts into the query as written, rather than as a
   * parameter: a table name or a file path built in code. Never pass it
   * text from outside the notebook.
   *
   * @param text SQL text.
   * @example
   * ```ts
   * const table = "moons";
   * await jupyter.sql`select count(*) as n from ${jupyter.sql.raw(table)}`;
   * ```
   */
  raw(text: string): SqlFragment;
  /**
   * Create (or replace) table `name` from a file DuckDB can read (CSV,
   * Parquet or JSON, by path or URL), from an array of row objects, or
   * from an Arrow table or Polars DataFrame. Rows go in as one JSON
   * parameter, typed from the values: integers as `BIGINT`, numbers as
   * `DOUBLE`, `Date`s as `TIMESTAMP`, arrays and objects as `JSON`.
   *
   * @param name The table's name.
   * @param source A path or URL, rows, an Arrow table or a DataFrame.
   * @throws {TypeError} `name` is empty, or the rows have no columns.
   * @example
   * ```ts
   * await jupyter.sql.load("moons", [
   *   { moon: "Io", radius_km: 1821.6 },
   *   { moon: "Ganymede", radius_km: 2634.1 },
   * ]);
   * await jupyter.sql`select moon from moons order by radius_km desc`;
   * ```
   */
  load(name: string, source: unknown): Promise<void>;
  /**
   * Close the database and free its memory. The next query opens a new,
   * empty one.
   *
   * @example
   * ```ts
   * await jupyter.sql.close();
   * ```
   */
  close(): Promise<void>;
  /**
   * The DuckDB connection itself, for what the tag doesn't cover: a
   * `@duckdb/node-api` `DuckDBConnection` on Node, Deno and Bun, a
   * duckdb-wasm `AsyncDuckDBConnection` in the browser.
   *
   * @example
   * ```ts
   * const conn = await jupyter.sql.connection();
   * ```
   */
  connection(): Promise<unknown>;
}

export function decimalValue(words: ArrayLike<number> | number | bigint, scale: number): number;
export function toParam(value: unknown): unknown;
/** A parameter as a SQL literal. */
export function sqlLiteral(value: unknown): string;
/** The query with each `?` placeholder (outside strings, quoted names and comments) replaced by its parameter as a literal. */
export function inlineParams(text: string, params: unknown[]): string;
/** A DuckDB TIME as `HH:MM:SS[.fraction]`, from its count in the declared type's unit (microseconds by default). */
export function timeText(value: number | bigint, declared?: string): string;
/** Column names made unique: a repeated `id` becomes `id_1`, `id_2`, and so on. */
export function uniqueNames(names: readonly string[]): string[];
export function compose(strings: readonly string[], values: unknown[]): { text: string; params: unknown[] };
export function quoteIdent(name: string): string;
export function quoteString(text: string): string;
export function rowsAsJson(source: unknown): { structure: string | null; json: string };

export interface SqlEngine {
  query: (text: string, params: unknown[]) => Promise<SqlResult>;
  interrupt?: () => void;
  close: () => Promise<void>;
  connection: unknown;
}

export function createSql(options: {
  importModule: (specifier: string) => Promise<any>;
  mapped?: (specifier: string) => string | null | undefined;
  signal?: () => AbortSignal | undefined;
  openEngine?: () => Promise<SqlEngine>;
}): Sql;
