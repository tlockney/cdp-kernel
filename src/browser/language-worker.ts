// The language service in a page's Web Worker (#524): the Worker side of
// startBrowserKernel's `typescript` option. It loads TypeScript and its lib
// files from URLs the page gives it, puts them in an in-memory file system
// for NotebookTypesCore, and answers the requests that LanguageClient
// (src/language-client.ts) sends, through the LanguageServer both share
// with the Node worker thread. Until TypeScript has loaded, requests
// answer null, so the kernel answers from the runtime. A bundle of this
// file is dist/browser/language-worker.js.

import type TS from "typescript";
import { LanguageServer } from "../language-server.ts";
import type { WorkerRequest, WorkerResponse } from "../language-client.ts";
import { kernelGlobals, NotebookTypesCore, posixJoin, type TypesFileSystem } from "../notebook-types-core.ts";
import { BROWSER_GLOBALS } from "./language-globals.ts";

/** What the page sends first (see LanguageInit in src/browser/mod.ts). */
export interface LanguageInit {
  type: "init";
  /** URL of TypeScript's lib/typescript.js. */
  module: string;
  /** URL of the directory with its lib.*.d.ts files. */
  libs: string;
  /** URL of the directory with the kernel's runtime/*.d.mts files, if the page serves them. */
  runtimeTypes?: string;
}

const NOTEBOOK_DIR = "/notebook";
const LIB_DIR = "/lib";
const RUNTIME_DIR = "/runtime";

const post = (response: WorkerResponse) => (self as unknown as { postMessage(message: unknown): void }).postMessage(response);
const server = new LanguageServer(post);

const directory = (url: string) => (url.endsWith("/") ? url : `${url}/`);

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return await response.text();
}

/**
 * `entry` and every file it names, through `references`, fetched from
 * `base` into `files` under `dir`. Each step fetches its files together.
 */
async function fetchClosure(
  base: string,
  dir: string,
  entry: string,
  references: (text: string) => string[],
  files: Map<string, string>,
): Promise<void> {
  let wave = [entry];
  while (wave.length > 0) {
    const texts = await Promise.all(wave.map((name) => fetchText(new URL(name, directory(base)).href)));
    const next = new Set<string>();
    wave.forEach((name, i) => {
      files.set(`${dir}/${name}`, texts[i]);
      for (const dependency of references(texts[i])) if (!files.has(`${dir}/${dependency}`)) next.add(dependency);
    });
    wave = [...next];
  }
}

/** `/// <reference lib="es2015" />` names lib.es2015.d.ts. */
const libReferences = (text: string) =>
  [...text.matchAll(/\/\/\/\s*<reference\s+lib="([^"]+)"\s*\/>/g)].map((m) => `lib.${m[1].toLowerCase()}.d.ts`);

/** `from "./comm.d.mts"` and `import("./introspect.mjs")` name comm.d.mts and introspect.d.mts. */
const runtimeReferences = (text: string) =>
  [...text.matchAll(/(?:from |import\()\s*"\.\/([\w.-]+?)\.(?:d\.mts|mjs)"/g)].map((m) => `${m[1]}.d.mts`);

/** TypeScript's lib/typescript.js is a CommonJS script: run it with a `module` to read `exports` from. */
async function loadTypeScript(url: string): Promise<typeof TS> {
  const source = await fetchText(url);
  const module: { exports: unknown } = { exports: {} };
  new Function("module", "exports", `${source}\n//# sourceURL=${url}`)(module, module.exports);
  const ts = module.exports as typeof TS;
  if (typeof ts?.createLanguageService !== "function") throw new Error(`${url} is not TypeScript's typescript.js`);
  return ts;
}

function memoryFileSystem(files: Map<string, string>): TypesFileSystem {
  const prefixes = (dir: string) => directory(dir.replace(/\/+$/, ""));
  return {
    readFile: (path) => files.get(path),
    fileExists: (path) => files.has(path),
    directoryExists: (path) => {
      const prefix = prefixes(path);
      for (const file of files.keys()) if (file.startsWith(prefix)) return true;
      return false;
    },
    getDirectories: (path) => {
      const prefix = prefixes(path);
      const names = new Set<string>();
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash > 0) names.add(rest.slice(0, slash));
      }
      return [...names];
    },
  };
}

async function start(init: LanguageInit): Promise<void> {
  let ts: typeof TS;
  const files = new Map<string, string>();
  let display: string | null = null;
  try {
    [ts] = await Promise.all([loadTypeScript(init.module), fetchClosure(init.libs, LIB_DIR, "lib.esnext.d.ts", libReferences, files)]);
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim().slice(0, 500);
    post({ unavailable: `no typescript: ${reason}` });
    return;
  }
  if (init.runtimeTypes !== undefined) {
    // The types of `jupyter`. Without them it is `any`, not a reason to give up.
    try {
      await fetchClosure(init.runtimeTypes, RUNTIME_DIR, "display.d.mts", runtimeReferences, files);
      display = `${RUNTIME_DIR}/display.mjs`;
    } catch (err) {
      console.warn(`[cdp-kernel] no runtime types for completion: ${err instanceof Error ? err.message : err}`);
    }
  }
  const service = new NotebookTypesCore(ts, {
    notebookDir: NOTEBOOK_DIR,
    npmCache: null,
    types: [],
    typeFiles: [],
    globals: kernelGlobals(display),
  }, { fs: memoryFileSystem(files), join: posixJoin, libDir: LIB_DIR });
  service.addVirtualTypeFile("__cdpk_browser__.d.ts", BROWSER_GLOBALS);
  server.start(service);
  post({ loaded: ts.version });
}

self.addEventListener("message", (event) => {
  const data = (event as MessageEvent).data as WorkerRequest | LanguageInit;
  if (data.type === "init") void start(data);
  else server.handle(data);
});
