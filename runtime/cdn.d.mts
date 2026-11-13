export const DEFAULT_CDN: string;
export function resolveSpecifier(
  specifier: string,
  base: string,
  cdn?: string,
  modules?: { readonly [specifier: string]: string },
): string;
