import type { Handler } from "./evaluator.mjs";

export function startChannel(handle: Handler, ready: { [key: string]: unknown }, fd?: number): void;
