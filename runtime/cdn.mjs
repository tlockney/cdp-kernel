// Where a browser cell's imports load from. A Worker resolves only URLs, so
// packages come from a CDN that serves npm and jsr as ES modules: esm.sh by
// default, with its jsr/ prefix for jsr packages.
//
// No imports: this file must load in every target.

export const DEFAULT_CDN = "https://esm.sh/";

/**
 * The URL `specifier`, imported from `base`, loads from. `modules` maps
 * specifiers, as written, to URLs (resolved against `base`) that win over
 * the CDN: an app ships the packages it needs offline this way.
 */
export function resolveSpecifier(specifier, base, cdn = DEFAULT_CDN, modules = undefined) {
  if (modules && Object.hasOwn(modules, specifier)) return new URL(modules[specifier], base).href;
  if (/^(?:https?|data|blob):/.test(specifier)) return specifier;
  if (/^\.{0,2}\//.test(specifier)) return new URL(specifier, base).href;
  if (specifier.startsWith("npm:")) return cdn + specifier.slice(4);
  if (specifier.startsWith("jsr:")) return `${cdn}jsr/${specifier.slice(4).replace(/^\//, "")}`;
  // esm.sh serves polyfills for Node's builtins under node:.
  return cdn + specifier;
}
