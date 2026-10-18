// The worker thread that runs TypeScript's language service for the kernel
// (#273). It owns a NotebookTypes (src/notebook-types.ts) and answers the
// host's requests (src/language-service.ts) in order. Loading TypeScript
// and the first program take most of a second, which here doesn't hold up
// heartbeats, shell or control messages.

import { parentPort, workerData } from "node:worker_threads";
import { join } from "node:path";
import ts from "typescript";
import { ensureInstalledAsync } from "../runtime/node-hooks.mjs";
import { kernelGlobals, NotebookTypes } from "./notebook-types.ts";
import type { WorkerOptions, WorkerRequest, WorkerResponse } from "./language-service.ts";

const options = workerData as WorkerOptions;
const types = new NotebookTypes(ts, {
  notebookDir: options.notebookDir,
  npmCache: options.npmCache,
  types: [],
  typeFiles: [],
  globals: kernelGlobals(options.display),
});

/**
 * A type package for the target's globals (@types/node on Node): the
 * notebook project's own when it has one, else installed once into the
 * kernel's npm cache, in the background. Completion goes on without it
 * meanwhile, and without it at all if the install fails (offline).
 */
async function addTypePackage({ name, range }: { name: string; range: string }): Promise<void> {
  const short = name.replace(/^@types\//, "");
  if (types.resolvesTypes(short)) {
    types.addTypeNames([short]);
    return;
  }
  try {
    const { dir, alias } = await ensureInstalledAsync({ name, range });
    types.addTypeFiles([join(dir, "node_modules", alias, "index.d.ts")]);
  } catch (err) {
    process.stderr.write(`[cdp-kernel] no ${name} for completion: ${err instanceof Error ? err.message : err}\n`);
  }
}

for (const pkg of options.typePackages) void addTypePackage(pkg);

parentPort?.on("message", (request: WorkerRequest) => {
  let response: WorkerResponse;
  switch (request.type) {
    case "cell":
      types.addCell(request.code);
      return;
    case "reset":
      types.reset();
      return;
    case "complete":
    case "quickInfo":
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
