export type Resolved =
  | { found: false }
  | { found: true; accessor: true; name: string }
  | { found: true; value: unknown; accessor?: undefined };

export function resolvePath(path: string, root?: object): Resolved;
// deno-lint-ignore ban-types -- classes and functions alike
export function signatureOf(fn: Function): string;
export function describeValue(value: unknown, options: { inspect: (value: unknown) => string; detail?: number }): string;
export function inspectPath(
  path: string,
  options: { inspect: (value: unknown) => string; detail?: number; root?: object },
): string | null;
