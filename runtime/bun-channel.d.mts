import type { Handler } from "./evaluator.mjs";

export function startChannel(handle: Handler, ready: { [key: string]: unknown }, fd?: number): void;

/** Writes all of `text` to `fd` before returning, even if the fd is non-blocking. */
export function writeAll(fd: number, text: string | Uint8Array): void;
