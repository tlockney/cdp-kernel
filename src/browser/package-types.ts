// Fetches and caches TypeScript declaration files for packages imported in
// the browser target (#525): discovers types from `esm.sh`'s
// `X-TypeScript-Types` header, direct TypeScript URLs, or a CDN's
// `package.json` (`exports` / `types` / `typings`), walks referenced
// declaration files, keeps them in Cache Storage for offline use, and
// fails silently so unknown packages stay `any`. No Node imports.

import type TS from "typescript";
import { DEFAULT_CDN, resolveSpecifier } from "../../runtime/cdn.mjs";
import { NotebookTypesCore, posixJoin } from "../notebook-types-core.ts";

const CACHE_NAME = "cdp-kernel-types-v1";
const CACHE_PREFIX = "https://cdpk-types.invalid/";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_CLOSURE_FILES = 200;

export type ModulesMap = { readonly [specifier: string]: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Whether `specifier` is a package or remote import worth resolving types for. */
export function isFetchableSpecifier(specifier: string, modules?: ModulesMap): boolean {
  if (modules && Object.hasOwn(modules, specifier)) return true;
  return !/^(?:\.{0,2}\/|data:|blob:)/.test(specifier);
}

/** Virtual POSIX path in the Worker's memory FS for an HTTP(S) declaration URL. */
export function virtualPathForUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.port ? `${parsed.hostname}_${parsed.port}` : parsed.hostname;
  const scheme = parsed.protocol.slice(0, -1);
  const rawPath = posixJoin("/types", scheme, host, parsed.pathname);
  if (/\.(?:d\.[cm]?ts|[cm]?ts|tsx|[cm]?js|jsx)$/i.test(rawPath)) return rawPath;
  return `${rawPath.replace(/\/+$/, "")}.d.ts`;
}

function virtualOriginPrefix(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = parsed.port ? `${parsed.hostname}_${parsed.port}` : parsed.hostname;
    return `/types/${parsed.protocol.slice(0, -1)}/${host}`;
  } catch {
    return null;
  }
}

/** Splits an npm/bare package specifier into `{ pkg, subpath }` (preserving `@version`). */
export function parsePackageName(raw: string): { pkg: string; subpath: string } | null {
  if (!raw || raw.startsWith("/") || raw.startsWith(".")) return null;
  const parts = raw.split("/");
  const count = raw.startsWith("@") ? 2 : 1;
  if (parts.length < count || parts.slice(0, count).some((p) => p === "")) return null;
  return {
    pkg: parts.slice(0, count).join("/"),
    subpath: parts.slice(count).join("/"),
  };
}

/** Candidate `package.json` URLs and subpaths for a specifier resolved to `resolvedUrl`. */
export function packageJsonCandidates(
  specifier: string,
  resolvedUrl: string,
  cdn: string = DEFAULT_CDN,
): { manifestUrl: string; subpath: string }[] {
  const cdnDir = cdn.endsWith("/") ? cdn : `${cdn}/`;
  if (!/^(?:https?|data|blob):/i.test(specifier) && !/^\.{0,2}\//.test(specifier)) {
    const isJsr = specifier.startsWith("jsr:");
    const stripped = specifier.startsWith("npm:")
      ? specifier.slice(4)
      : isJsr
        ? specifier.slice(4).replace(/^\//, "")
        : specifier;
    const parsed = parsePackageName(stripped);
    if (parsed !== null) {
      try {
        // Prefix with `./` so names containing `:` (such as `node:events`) stay
        // relative to `cdnDir` instead of being parsed as a URL scheme.
        const root = new URL(`./${isJsr ? "jsr/" : ""}${parsed.pkg}/`, cdnDir).href;
        return [{
          manifestUrl: new URL("package.json", root).href,
          subpath: parsed.subpath ? `./${parsed.subpath}` : ".",
        }];
      } catch {
        return [];
      }
    }
  }
  try {
    const u = new URL(resolvedUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return [];
    const cleanUrl = `${u.origin}${u.pathname}`;
    if (/\.[cm]?js$/i.test(u.pathname)) {
      return [{ manifestUrl: new URL("package.json", cleanUrl).href, subpath: "." }];
    }
    const baseDir = cleanUrl.endsWith("/") ? cleanUrl : `${cleanUrl}/`;
    return [{ manifestUrl: new URL("package.json", baseDir).href, subpath: "." }];
  } catch {
    return [];
  }
}

function pickExportsTypes(target: unknown): string | null {
  if (!isRecord(target)) return null;
  if (typeof target.types === "string") return target.types;
  for (const key of ["import", "browser", "default"]) {
    if (key in target) {
      const nested = pickExportsTypes(target[key]);
      if (nested !== null) return nested;
    }
  }
  return null;
}

/** Reads the declaration entry path from a `package.json` manifest (`exports`, `types`, `typings`). */
export function resolvePackageTypesField(manifest: unknown, subpath: string): string | null {
  if (!isRecord(manifest)) return null;
  const exportsField = manifest.exports;
  if (isRecord(exportsField)) {
    const keys = Object.keys(exportsField);
    const hasSubpathKeys = keys.some((k) => k === "." || k.startsWith("./"));
    if (hasSubpathKeys) {
      const target = exportsField[subpath];
      const found = pickExportsTypes(target);
      if (found !== null) return found;
    } else if (subpath === ".") {
      const found = pickExportsTypes(exportsField);
      if (found !== null) return found;
    }
  }
  if (subpath === ".") {
    if (typeof manifest.types === "string") return manifest.types;
    if (typeof manifest.typings === "string") return manifest.typings;
  }
  return null;
}

/** Candidate URLs to try when resolving a relative or root-relative reference inside a `.d.ts`. */
export function referenceCandidates(ref: string, fromUrl: string): string[] {
  const clean = ref.split(/[?#]/)[0] ?? ref;
  if (/\.(?:d\.[cm]?ts|[cm]?ts|tsx)$/i.test(clean)) return [new URL(ref, fromUrl).href];
  if (/\.js$/i.test(clean)) {
    return [
      new URL(ref.replace(/\.js(\?.*)?$/i, ".d.ts$1"), fromUrl).href,
      new URL(ref.replace(/\.js(\?.*)?$/i, ".ts$1"), fromUrl).href,
    ];
  }
  if (/\.mjs$/i.test(clean)) {
    return [
      new URL(ref.replace(/\.mjs(\?.*)?$/i, ".d.mts$1"), fromUrl).href,
      new URL(ref.replace(/\.mjs(\?.*)?$/i, ".mts$1"), fromUrl).href,
    ];
  }
  if (/\.cjs$/i.test(clean)) {
    return [
      new URL(ref.replace(/\.cjs(\?.*)?$/i, ".d.cts$1"), fromUrl).href,
      new URL(ref.replace(/\.cjs(\?.*)?$/i, ".cts$1"), fromUrl).href,
    ];
  }
  return [
    new URL(`${ref}.d.ts`, fromUrl).href,
    new URL(`${ref}.d.mts`, fromUrl).href,
    new URL(`${ref}/index.d.ts`, fromUrl).href,
    new URL(`${ref}/index.d.mts`, fromUrl).href,
  ];
}

/** Rewrites root-relative `/// <reference path="/..." />` to the origin's `/types/...` VFS prefix. */
export function rewriteRootReferencePaths(text: string, originPrefix: string): string {
  return text.replace(
    /(\/\/\/\s*<reference\s+path=["'])(\/[^"']+)(["']\s*\/>)/g,
    (_, before: string, path: string, after: string) => `${before}${posixJoin(originPrefix, path)}${after}`,
  );
}

interface CachedPackageEntry {
  entryPath: string;
  files: { url: string; path: string }[];
  mappings: [string, string][];
}

function isCachedPackageEntry(value: unknown): value is CachedPackageEntry {
  if (!isRecord(value) || typeof value.entryPath !== "string" || !Array.isArray(value.files) || !Array.isArray(value.mappings)) {
    return false;
  }
  return value.files.every((f) => isRecord(f) && typeof f.url === "string" && typeof f.path === "string") &&
    value.mappings.every((m) => Array.isArray(m) && m.length === 2 && typeof m[0] === "string" && typeof m[1] === "string");
}

function entryCacheKey(resolvedUrl: string): string {
  return `${CACHE_PREFIX}entry?url=${encodeURIComponent(resolvedUrl)}`;
}

function fileCacheKey(fileUrl: string): string {
  return `${CACHE_PREFIX}file?url=${encodeURIComponent(fileUrl)}`;
}

async function openCache(): Promise<Cache | null> {
  try {
    if (typeof caches === "undefined") return null;
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

function isTypeScriptUrl(url: string, contentType: string | null): boolean {
  try {
    const pathname = new URL(url).pathname;
    if (/\.(?:d\.[cm]?ts|[cm]?ts|tsx)$/i.test(pathname)) return true;
  } catch {
    return false;
  }
  return contentType !== null && /\btypescript\b/i.test(contentType);
}

export interface PackageTypesOptions {
  ts: typeof TS;
  service: NotebookTypesCore;
  files: Map<string, string>;
  base: string;
  cdn?: string;
  modules?: ModulesMap;
}

/**
 * Loads declaration closures for browser-target imports over HTTP and
 * persists them in Cache Storage for offline sessions (#525).
 */
export class PackageTypesLoader {
  readonly #ts: typeof TS;
  readonly #service: NotebookTypesCore;
  readonly #files: Map<string, string>;
  readonly #base: string;
  readonly #cdn: string;
  readonly #modules: ModulesMap | undefined;
  readonly #inFlight = new Map<string, Promise<void>>();
  readonly #settled = new Set<string>();

  constructor(options: PackageTypesOptions) {
    this.#ts = options.ts;
    this.#service = options.service;
    this.#files = options.files;
    this.#base = options.base;
    const rawCdn = options.cdn ?? DEFAULT_CDN;
    this.#cdn = rawCdn.endsWith("/") ? rawCdn : `${rawCdn}/`;
    this.#modules = options.modules;
  }

  /** Extracts fetchable import/export/dynamic-import specifiers from `code`. */
  extractSpecifiers(code: string): string[] {
    const info = this.#ts.preProcessFile(code, true, true);
    const out: string[] = [];
    for (const file of info.importedFiles) {
      if (isFetchableSpecifier(file.fileName, this.#modules) && !out.includes(file.fileName)) {
        out.push(file.fileName);
      }
    }
    return out;
  }

  /** Kicks off loading declaration files for any unseen fetchable specifiers. */
  ensure(specifiers: readonly string[]): void {
    for (const specifier of specifiers) {
      if (!isFetchableSpecifier(specifier, this.#modules)) continue;
      if (this.#settled.has(specifier) || this.#inFlight.has(specifier)) continue;
      const task = this.#loadSpecifier(specifier)
        .catch(() => {
          // Failures stay silent so unknown/offline imports remain `any`.
        })
        .finally(() => {
          this.#inFlight.delete(specifier);
          this.#settled.add(specifier);
        });
      this.#inFlight.set(specifier, task);
    }
  }

  /**
   * Waits briefly for newly started in-flight fetches so Cache Storage hits and
   * fast responses apply on the current request without repeatedly delaying on slow networks.
   */
  async waitBriefly(maxMs = 150): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const [specifier, promise] of this.#inFlight) {
      if (this.#waitedOnce.has(specifier)) continue;
      this.#waitedOnce.add(specifier);
      pending.push(promise);
    }
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, maxMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }

  readonly #waitedOnce = new Set<string>();

  async #loadSpecifier(specifier: string): Promise<void> {
    const resolvedUrl = resolveSpecifier(specifier, this.#base, this.#cdn, this.#modules);
    if (await this.#loadFromCache(specifier, resolvedUrl)) return;

    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const entryUrl = await this.#discoverEntryUrl(specifier, resolvedUrl, signal);
    if (entryUrl === null) return;

    const loaded = new Map<string, { url: string; path: string; text: string }>();
    const mappings: [string, string][] = [];
    const seenUrls = new Set<string>();
    const entryPath = await this.#fetchClosure(entryUrl, loaded, mappings, seenUrls, signal);
    if (entryPath === null || loaded.size === 0) return;

    for (const file of loaded.values()) this.#files.set(file.path, file.text);
    this.#service.addResolvedModule(specifier, entryPath);
    for (const [depSpec, depPath] of mappings) this.#service.addResolvedModule(depSpec, depPath);

    await this.#saveToCache(resolvedUrl, {
      entryPath,
      files: [...loaded.values()].map(({ url, path }) => ({ url, path })),
      mappings,
    }, loaded);
  }

  async #loadFromCache(specifier: string, resolvedUrl: string): Promise<boolean> {
    const cache = await openCache();
    if (cache === null) return false;
    try {
      const entryRes = await cache.match(entryCacheKey(resolvedUrl));
      if (!entryRes?.ok) return false;
      const raw: unknown = await entryRes.json();
      if (!isCachedPackageEntry(raw)) return false;
      const responses = await Promise.all(raw.files.map((f) => cache.match(fileCacheKey(f.url))));
      if (responses.some((r) => !r?.ok)) return false;
      const texts = await Promise.all(responses.map((r) => r!.text()));
      raw.files.forEach((f, i) => this.#files.set(f.path, texts[i]));
      this.#service.addResolvedModule(specifier, raw.entryPath);
      for (const [depSpec, depPath] of raw.mappings) this.#service.addResolvedModule(depSpec, depPath);
      return true;
    } catch {
      return false;
    }
  }

  async #saveToCache(
    resolvedUrl: string,
    manifest: CachedPackageEntry,
    loaded: Map<string, { url: string; path: string; text: string }>,
  ): Promise<void> {
    const cache = await openCache();
    if (cache === null) return;
    try {
      await Promise.all(
        [...loaded.values()].map((file) =>
          cache.put(
            fileCacheKey(file.url),
            new Response(file.text, { headers: { "content-type": "text/plain; charset=utf-8" } }),
          )
        ),
      );
      await cache.put(
        entryCacheKey(resolvedUrl),
        new Response(JSON.stringify(manifest), { headers: { "content-type": "application/json; charset=utf-8" } }),
      );
    } catch {
      // Quota or private-mode Cache Storage failures stay silent.
    }
  }

  async #discoverEntryUrl(specifier: string, resolvedUrl: string, signal: AbortSignal): Promise<string | null> {
    let head = await this.#tryFetch(resolvedUrl, "HEAD", signal);
    if (head !== null && (head.status === 405 || head.status === 501)) {
      head = await this.#tryFetch(resolvedUrl, "GET", signal);
    }
    if (head !== null) {
      const typesHeader = head.headers.get("x-typescript-types")?.trim();
      void head.body?.cancel();
      if (typesHeader) return new URL(typesHeader, head.url || resolvedUrl).href;
      if (head.ok && isTypeScriptUrl(head.url || resolvedUrl, head.headers.get("content-type"))) {
        return head.url || resolvedUrl;
      }
    }

    for (const candidate of packageJsonCandidates(specifier, resolvedUrl, this.#cdn)) {
      const res = await this.#tryFetch(candidate.manifestUrl, "GET", signal);
      if (!res?.ok) {
        void res?.body?.cancel();
        continue;
      }
      try {
        const manifest: unknown = await res.json();
        const rel = resolvePackageTypesField(manifest, candidate.subpath) ??
          (candidate.subpath === "." ? "./index.d.ts" : null);
        if (rel !== null) return new URL(rel, res.url || candidate.manifestUrl).href;
      } catch {
        // Ignore malformed package.json and continue.
      }
    }
    return null;
  }

  async #fetchClosure(
    entryUrl: string,
    loaded: Map<string, { url: string; path: string; text: string }>,
    mappings: [string, string][],
    seenUrls: Set<string>,
    signal: AbortSignal,
  ): Promise<string | null> {
    const fallbackPath = virtualPathForUrl(entryUrl);
    if (fallbackPath === null) return null;

    let resolvedEntryPath: string | null = null;
    // Separate from `seenUrls` so a dependency whose discovered entry URL equals
    // its import specifier (e.g. a direct `.d.ts` HTTP URL) is still fetched.
    const seenDeps = new Set<string>();
    const queue: { candidates: string[]; isEntry?: boolean; specifier?: string }[] = [
      { candidates: [entryUrl], isEntry: true },
    ];
    while (queue.length > 0 && loaded.size < MAX_CLOSURE_FILES) {
      const item = queue.shift()!;
      const fetched = await this.#fetchFirst(item.candidates, seenUrls, signal);
      if (fetched === null) continue;
      if (fetched.alreadyLoaded) {
        const existing = loaded.get(fetched.url);
        if (item.specifier !== undefined && existing !== undefined) {
          mappings.push([item.specifier, existing.path]);
        }
        continue;
      }

      const vPath = virtualPathForUrl(fetched.url);
      const originPrefix = virtualOriginPrefix(fetched.url);
      if (vPath === null || originPrefix === null) continue;
      if (item.isEntry) resolvedEntryPath = vPath;
      if (item.specifier !== undefined) mappings.push([item.specifier, vPath]);
      const text = rewriteRootReferencePaths(fetched.text, originPrefix);
      loaded.set(fetched.url, { url: fetched.url, path: vPath, text });

      const info = this.#ts.preProcessFile(text, true, true);
      const refs = [...info.referencedFiles, ...info.importedFiles].map((r) => r.fileName);
      for (const ref of refs) {
        if (/^(?:\.{0,2}\/|\/)/.test(ref)) {
          queue.push({ candidates: referenceCandidates(ref, fetched.url) });
        } else if (/^https?:\/\//i.test(ref)) {
          if (!seenDeps.has(ref) && loaded.size + queue.length < MAX_CLOSURE_FILES) {
            seenDeps.add(ref);
            try {
              const subUrl = await this.#discoverEntryUrl(ref, ref, signal);
              if (subUrl !== null) queue.push({ candidates: [subUrl], specifier: ref });
            } catch {
              // One unreachable dependency must not abort the parent package.
            }
          }
        } else if (isFetchableSpecifier(ref, this.#modules) && loaded.size + queue.length < MAX_CLOSURE_FILES) {
          const resolvedDep = resolveSpecifier(ref, fetched.url, this.#cdn, this.#modules);
          if (!seenDeps.has(resolvedDep)) {
            seenDeps.add(resolvedDep);
            try {
              const subUrl = await this.#discoverEntryUrl(ref, resolvedDep, signal);
              if (subUrl !== null) queue.push({ candidates: [subUrl], specifier: ref });
            } catch {
              // One unreachable dependency must not abort the parent package.
            }
          }
        }
      }
    }
    return loaded.size > 0 ? (resolvedEntryPath ?? fallbackPath) : null;
  }

  async #fetchFirst(
    candidates: string[],
    seenUrls: Set<string>,
    signal: AbortSignal,
  ): Promise<{ alreadyLoaded: true; url: string } | { alreadyLoaded: false; url: string; text: string } | null> {
    for (const url of candidates) {
      if (seenUrls.has(url)) return { alreadyLoaded: true, url };
      seenUrls.add(url);
      const res = await this.#tryFetch(url, "GET", signal);
      if (!res?.ok) {
        void res?.body?.cancel();
        continue;
      }
      const finalUrl = res.url || url;
      if (finalUrl !== url) seenUrls.add(finalUrl);
      return { alreadyLoaded: false, url: finalUrl, text: await res.text() };
    }
    return null;
  }

  async #tryFetch(url: string, method: "HEAD" | "GET", signal: AbortSignal): Promise<Response | null> {
    try {
      return await fetch(url, { method, signal });
    } catch {
      return null;
    }
  }
}
