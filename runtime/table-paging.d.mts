import type { CommApi } from "./comm.d.mts";
import type { TablePager } from "./table.d.mts";

/** The comm target a frontend opens, with `{ id }`, to page through a table. */
export const PAGE_TARGET: "ganymede.table.v1";
/** How many tables the kernel keeps for paging, the newest. */
export const KEEP: number;
/** The most rows one request returns. */
export const MAX_PAGE: number;
/** The most rows a table can have to be sorted in the kernel. */
export const MAX_SORT: number;

/** Compares two encoded values of a column as the Ganymede apps' table does. */
export function compareEncoded(a: unknown, b: unknown, type: string | undefined, descending?: boolean): number;

export function createTablePager(
  commApi: CommApi,
  options?: { keep?: number; newId?: () => string },
): TablePager & { size(): number };
