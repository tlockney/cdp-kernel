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

export interface TableBundleOptions {
  limit?: number;
  title?: string;
  columns?: string[];
}

export function isArrowTable(value: unknown): boolean;
export function isPolarsFrame(value: unknown): boolean;
export function isDuckDBResult(value: unknown): boolean;
export function isTableLike(value: unknown): boolean;
export function schemaType(declared: unknown): string | undefined;
export function encodeValue(value: unknown, type: string): unknown;
export function tableSource(value: unknown, options?: TableBundleOptions): TableSource;
export function tableBundle(source: TableSource, options?: TableBundleOptions): { [mediaType: string]: unknown };
