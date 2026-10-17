#!/usr/bin/env node
// cdp-kernel CLI.
//   cdp-kernel install [--runtime node|deno|bun|workerd|celld] [--deno-compat] [--type-strip esbuild] [--name NAME] [--display NAME]
//   cdp-kernel kernel --runtime node|deno|bun|workerd|celld [--deno-compat] [--type-strip esbuild] --conn CONNECTION_FILE
//   cdp-kernel version
//
// --deno-compat (Node only) adds a `Deno` namespace for notebooks written for
// `deno jupyter`; see runtime/deno-compat.mjs. --type-strip picks what
// removes cells' types (src/transform.ts).

import process from "node:process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Kernel, parseConnectionInfo } from "./kernel.ts";
import type { RuntimeName } from "./target.ts";
import { isTypeStripperName, type TypeStripperName } from "./transform.ts";
import { hostRuntime, kernelArgv, moduleOrigin, VERSION } from "./package.ts";

function isRuntime(value: unknown): value is RuntimeName {
  return value === "node" || value === "deno" || value === "bun" || value === "workerd" || value === "celld";
}

function kernelsDir(): string {
  if (process.env.JUPYTER_DATA_DIR) return join(process.env.JUPYTER_DATA_DIR, "kernels");
  if (platform() === "darwin") return join(homedir(), "Library", "Jupyter", "kernels");
  if (platform() === "win32") return join(process.env.APPDATA ?? homedir(), "jupyter", "kernels");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "jupyter", "kernels");
}

function install(runtime: RuntimeName, denoCompat: boolean, typeStrip: TypeStripperName, name: string, display: string): void {
  const dir = join(kernelsDir(), name);
  mkdirSync(dir, { recursive: true });
  const spec = {
    argv: kernelArgv(hostRuntime(), process.execPath, moduleOrigin(import.meta.url), [
      "kernel",
      "--runtime",
      runtime,
      ...(denoCompat ? ["--deno-compat"] : []),
      ...(typeStrip !== "esbuild" ? ["--type-strip", typeStrip] : []),
      "--conn",
      "{connection_file}",
    ]),
    display_name: display,
    language: "typescript",
    // Interrupts arrive as interrupt_request on the control channel rather
    // than as SIGINT to this process.
    interrupt_mode: "message",
    // JupyterLab enables its visual debugger from metadata.debugger (#18);
    // only the targets driven over CDP have one.
    metadata: { runtime, denoCompat, version: VERSION, debugger: runtime === "node" || runtime === "deno" },
  };
  writeFileSync(join(dir, "kernel.json"), JSON.stringify(spec, null, 2) + "\n");
  console.log(`installed kernelspec ${name} -> ${dir}`);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    runtime: { type: "string", default: "node" },
    conn: { type: "string" },
    name: { type: "string" },
    display: { type: "string" },
    "deno-compat": { type: "boolean", default: false },
    "type-strip": { type: "string", default: "esbuild" },
  },
});

const runtime = values.runtime;
if (!isRuntime(runtime)) {
  console.error(`unknown runtime ${runtime}; expected node, deno, bun, workerd or celld`);
  process.exit(2);
}

const typeStrip = values["type-strip"];
if (!isTypeStripperName(typeStrip)) {
  console.error(`unknown type stripper ${typeStrip}; expected esbuild`);
  process.exit(2);
}

// Deno targets have the real namespace; the shim is for Node.
const denoCompat = values["deno-compat"] === true && runtime === "node";

switch (positionals[0]) {
  case "install": {
    const suffix = denoCompat ? "-deno" : "";
    install(
      runtime,
      denoCompat,
      typeStrip,
      values.name ?? `cdp-${runtime}${suffix}`,
      values.display ?? `TypeScript (cdp-kernel, ${runtime}${denoCompat ? ", Deno compat" : ""})`,
    );
    break;
  }
  case "kernel": {
    if (!values.conn) {
      console.error("kernel: --conn CONNECTION_FILE is required");
      process.exit(2);
    }
    const kernel = new Kernel(parseConnectionInfo(readFileSync(values.conn, "utf8")), runtime, { denoCompat, typeStrip });
    await kernel.run();
    break;
  }
  case "version":
    console.log(VERSION);
    break;
  default:
    console.error(
      "usage: cdp-kernel install [--runtime node|deno|bun|workerd|celld] [--deno-compat] [--type-strip esbuild] | kernel --runtime node|deno|bun|workerd|celld --conn FILE | version",
    );
    process.exit(2);
}
