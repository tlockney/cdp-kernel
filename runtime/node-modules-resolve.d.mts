/** True for "pkg", "@scope/pkg", "pkg/sub"; false for paths, URLs and aliases like "@/x". */
export function isBareSpecifier(specifier: string): boolean;

/**
 * An absolute file URL for a bare package import, resolved from the
 * node_modules at or above `fromDir`, or null when none has the package.
 */
export function resolveFromNodeModules(specifier: string, fromDir: string): string | null;
