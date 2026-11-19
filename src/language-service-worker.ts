// The worker thread that runs TypeScript's language service for the kernel
// (#273). It owns a NotebookTypes (src/notebook-types.ts) and answers the
// host's requests (src/language-service.ts) in order. Loading TypeScript
// and the first program take most of a second, which here doesn't hold up
// heartbeats, shell or control messages.
//
// TypeScript itself is located, or installed into the npm cache, when the
// worker starts (#513, src/typescript-package.ts). Until it's loaded,
// requests get a null result, so the kernel answers from the runtime.

import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureInstalledAsync } from "../runtime/node-hooks.mjs";
import { kernelGlobals, NotebookTypes } from "./notebook-types.ts";
import { DenoResolver, denoTypes } from "./deno-types.ts";
import { loadTypeScript } from "./typescript-package.ts";
import type { WorkerOptions, WorkerRequest, WorkerResponse } from "./language-service.ts";

const options = workerData as WorkerOptions;
/** Null until TypeScript is loaded. */
let types: NotebookTypes | null = null;
/** Cells that ran before TypeScript loaded, replayed to it. */
let cells: string[] = [];

/** A package's declaration entry point: package.json "types"/"typings", else index.d.ts. */
function typesEntry(dir: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const entry = manifest.types ?? manifest.typings;
    if (typeof entry === "string") return join(dir, entry);
  } catch {
    // No readable package.json: fall back to the convention.
  }
  return join(dir, "index.d.ts");
}

/**
 * A type package for the target's globals (@types/node on Node, @types/bun,
 * @cloudflare/workers-types): the
 * notebook project's own when it has one, else installed once into the
 * kernel's npm cache, in the background. Completion goes on without it
 * meanwhile, and without it at all if the install fails (offline).
 */
async function addTypePackage(types: NotebookTypes, { name, range }: { name: string; range: string }): Promise<void> {
  const short = name.replace(/^@types\//, "");
  if (types.resolvesTypes(short)) {
    types.addTypeNames([short]);
    return;
  }
  try {
    const { dir, alias } = await ensureInstalledAsync({ name, range });
    types.addTypeFiles([typesEntry(join(dir, "node_modules", alias))]);
  } catch (err) {
    process.stderr.write(`[cdp-kernel] no ${name} for completion: ${err instanceof Error ? err.message : err}\n`);
  }
}

/** Locates (or installs) TypeScript and starts the service on it. */
async function start(): Promise<void> {
  let ts;
  try {
    ts = await loadTypeScript(options.notebookDir);
  } catch (err) {
    // One log line: an npm failure's own output can run to many.
    const reason = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim().slice(0, 500);
    parentPort?.postMessage({ unavailable: `no typescript: ${reason}` } satisfies WorkerResponse);
    return;
  }
  const service = new NotebookTypes(ts, {
    notebookDir: options.notebookDir,
    npmCache: options.npmCache,
    deno: options.deno === null
      ? undefined
      : new DenoResolver({ config: options.deno.config, root: join(options.notebookDir, "__cdpk_remote__") }),
    types: [],
    typeFiles: options.typeFiles,
    globals: kernelGlobals(options.display),
  });
  if (options.denoTypes) {
    const declarations = denoTypes();
    if (declarations !== null) service.addVirtualTypeFile("__cdpk_deno__.d.ts", declarations);
    else process.stderr.write("[cdp-kernel] no Deno types for completion: `deno types` failed\n");
  }
  for (const code of cells) service.addCell(code);
  cells = [];
  types = service;
  parentPort?.postMessage({ loaded: ts.version } satisfies WorkerResponse);
  for (const pkg of options.typePackages) void addTypePackage(service, pkg);
}

void start();

parentPort?.on("message", (request: WorkerRequest) => {
  let response: WorkerResponse;
  switch (request.type) {
    case "cell":
      if (types === null) cells.push(request.code);
      else types.addCell(request.code);
      return;
    case "reset":
      if (types === null) cells = [];
      else types.reset();
      return;
    case "complete":
    case "quickInfo":
      if (types === null) {
        parentPort?.postMessage({ id: request.id, result: null } satisfies WorkerResponse);
        return;
      }
      try {
        response = request.type === "complete"
          ? { id: request.id, result: types.complete(request.code, request.cursor) }
          : { id: request.id, result: types.quickInfo(request.code, request.cursor) };
      } catch (err) {
        response = { id: request.id, error: err instanceof Error ? err.stack ?? err.message : String(err) };
      }
      parentPort?.postMessage(response);
  }
});
