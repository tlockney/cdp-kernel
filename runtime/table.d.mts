/** The MIME type of a table output: Table Schema JSON with rows. */
export const TABLE_MIME: "application/vnd.dataresource+json";
export const DEFAULT_LIMIT: number;
export const MAX_LIMIT: number;
export const MAX_BYTES: number;
export const MAX_CELL: number;

export interface TableColumn {
  name: string;
  /** The source's own type name, such as `Int64` or `VARCHAR`. */
  declared?: string;
}

/** Columns and random access to rows, which `jupyter.table` reads from. */
export interface TableSource {
  columns: TableColumn[];
  total: number;
  read: (start: number, end: number) => unknown[][];
}

/** Keeps a table cut by the cap for paging through the kernel; returns its id. */
export interface TablePager {
  register(source: TableSource, fields: { name: string; type: string }[]): string;
}

export function setTablePager(pager: TablePager | null): void;

export interface TableBundleOptions {
  limit?: number;
  title?: string;
  columns?: string[];
  /** Keeps the table if the cap cuts it; the one `setTablePager` set by default, `null` for none. */
  pager?: TablePager | null;
}

export function isArrowTable(value: unknown): boolean;
export function isPolarsFrame(value: unknown): boolean;
export function isDuckDBResult(value: unknown): boolean;
export function isTableLike(value: unknown): boolean;
export function schemaType(declared: unknown): string | undefined;
export function encodeValue(value: unknown, type: string, declared?: string): unknown;
/** A time of day as `HH:MM:SS[.fraction]`, from a count in the declared type's unit (microseconds by default). */
export function timeText(value: number | bigint, declared?: string): string;
/** Column names made unique: a repeated `id` becomes `id_1`, `id_2`, and so on. */
export function uniqueNames(names: readonly string[]): string[];
export function tableSource(value: unknown, options?: TableBundleOptions): TableSource;
export function tableBundle(source: TableSource, options?: TableBundleOptions): { [mediaType: string]: unknown };
export function fieldsOf(source: TableSource, rows: unknown[][]): { name: string; type: string }[];
