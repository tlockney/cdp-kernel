// The kernel process: KernelCore (src/kernel-core.ts) on the connection
// file's ZeroMQ ports, with a target runtime launched as a child process,
// the language service in a worker thread, and the visual debugger.

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { type RuntimeName, Target } from "./target.ts";
import { BunTarget } from "./bun-target.ts";
import { Debugger } from "./debugger.ts";
import { WorkerdTarget } from "./workerd-target.ts";
import { launchCelld } from "./celld-target.ts";
import type { TypeStripper, TypeStripperName } from "./transform.ts";
import { type DenoProject, loadDenoProject } from "./deno-config.ts";
import { LanguageService, type WorkerOptions } from "./language-service.ts";
import { findWranglerConfig } from "./workers-project.ts";
import { cacheRoot, VERSION } from "./package.ts";
import { watchParent } from "./parent.ts";
import { KernelCore } from "./kernel-core.ts";
import { ZmqChannels } from "./zmq-channels.ts";

export interface ConnectionInfo {
  ip: string;
  key: string;
  transport: string;
  signature_scheme: string;
  shell_port: number;
  control_port: number;
  stdin_port: number;
  iopub_port: number;
  hb_port: number;
}

/** The installed TypeScript's version, for kernel_info's language_info (#340). */
function typescriptVersion(): string | undefined {
  try {
    const { version } = createRequire(import.meta.url)("typescript/package.json") as { version?: unknown };
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Larger files get no source lines in a traceback. */
const MAX_SOURCE_BYTES = 1 << 20;

/** A traceback frame's file, read from disk when it is a local one (#322). */
function readSource(file: string): string | undefined {
  try {
    const path = file.startsWith("file:") ? fileURLToPath(file) : file;
    if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) return undefined;
    if (statSync(path).size > MAX_SOURCE_BYTES) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Where the target loads the kernel's runtime/*.mjs from: in place, or a cached copy (src/package.ts). */
function kernelFiles(): string[] {
  const runtime = new URL("../runtime/", import.meta.url);
  const files = [runtime.href, join(cacheRoot(), "runtime")];
  if (runtime.protocol === "file:") files.push(fileURLToPath(runtime));
  return files;
}

export function parseConnectionInfo(json: string): ConnectionInfo {
  const raw: unknown = JSON.parse(json);
  if (typeof raw !== "object" || raw === null) throw new Error("connection file is not an object");
  const info = raw as Partial<ConnectionInfo>;
  for (const port of ["shell_port", "control_port", "stdin_port", "iopub_port", "hb_port"] as const) {
    if (typeof info[port] !== "number") throw new Error(`connection file: missing ${port}`);
  }
  for (const field of ["ip", "key"] as const) {
    if (info[field] !== undefined && typeof info[field] !== "string") throw new Error(`connection file: ${field} is not a string`);
  }
  if (info.transport !== undefined && info.transport !== "tcp") {
    throw new Error(`unsupported transport ${info.transport}; only tcp is implemented`);
  }
  if (info.signature_scheme !== undefined && info.signature_scheme !== "hmac-sha256" && info.key) {
    throw new Error(`unsupported signature scheme ${info.signature_scheme}`);
  }
  return {
    ip: info.ip ?? "127.0.0.1",
    key: info.key ?? "",
    transport: "tcp",
    signature_scheme: "hmac-sha256",
    shell_port: info.shell_port as number,
    control_port: info.control_port as number,
    stdin_port: info.stdin_port as number,
    iopub_port: info.iopub_port as number,
    hb_port: info.hb_port as number,
  };
}

function log(text: string): void {
  process.stderr.write(`[cdp-kernel] ${text}\n`);
}

/** The target Node's major version, for @types/node: the host's, which is usually the same binary. */
function nodeMajor(): string {
  return process.versions.node?.split(".")[0] ?? "*";
}

/**
 * Where the language service gets each target's globals and imports from
 * (#273, #275). A `--deno-compat` Node target gets Node's types only: its
 * `Deno` namespace is partial, and Deno's declarations would promise
 * members it doesn't have.
 */
function languageServiceOptions(
  runtime: RuntimeName,
  notebookDir: string,
  project: DenoProject | null,
): Omit<WorkerOptions, "display"> {
  const base = { notebookDir, npmCache: "npm" as const, deno: null, denoTypes: false, typeFiles: [], typePackages: [] };
  switch (runtime) {
    case "node":
      return { ...base, typePackages: [{ name: "@types/node", range: nodeMajor() }] };
    case "deno":
      return { ...base, npmCache: null, deno: { config: project?.configPath ?? null }, denoTypes: true };
    case "bun":
      return { ...base, npmCache: "bun", typePackages: [{ name: "@types/bun", range: "1" }] };
    case "workerd":
    case "celld": {
      // A Workers project's own types (`wrangler types`) know its bindings.
      const config = findWranglerConfig(notebookDir);
      const generated = config === null ? null : join(dirname(config), "worker-configuration.d.ts");
      return generated !== null && existsSync(generated)
        ? { ...base, typeFiles: [generated] }
        : { ...base, typePackages: [{ name: "@cloudflare/workers-types", range: "*" }] };
    }
  }
}

/**
 * A kernel on its connection file's ports, running cells on a target
 * runtime launched as a child process. The message handling is
 * KernelCore's (src/kernel-core.ts); this is its Node wiring.
 */
export class Kernel {
  readonly #core: KernelCore;

  constructor(
    conn: ConnectionInfo,
    runtime: RuntimeName,
    options: {
      denoCompat?: boolean;
      /** Defaults to the process cwd, which Jupyter sets. */
      notebookDir?: string;
      /** What strips cells' types; esbuild by default (#238). */
      typeStrip?: TypeStripperName | TypeStripper;
      /** Typed completion from TypeScript's language service; on by default (#273). */
      languageService?: boolean;
    } = {},
  ) {
    const notebookDir = options.notebookDir ?? process.cwd();
    let warning: string | null = null;
    let project: DenoProject | null = null;
    // A Deno target in a Deno project uses its config (#13).
    if (runtime === "deno") {
      try {
        project = loadDenoProject(notebookDir);
      } catch (err) {
        // A broken deno.json mustn't stop the kernel: run as in a plain
        // directory and say why in the first cell.
        const reason = err instanceof Error ? err.message : String(err);
        warning = `${reason}; running without the project config`;
        log(warning);
      }
    }
    const denoCompat = options.denoCompat ?? false;
    this.#core = new KernelCore({
      runtime,
      version: VERSION,
      languageVersion: typescriptVersion(),
      channels: new ZmqChannels(conn, log),
      launchTarget(events) {
        if (runtime === "bun") return BunTarget.launch(events);
        if (runtime === "workerd") return WorkerdTarget.launch(events);
        if (runtime === "celld") return launchCelld(events);
        return Target.launch(runtime, events, { denoCompat, denoConfig: project?.configPath });
      },
      typeStrip: options.typeStrip,
      transform: project?.transform,
      warning,
      types: options.languageService === false
        ? null
        : new LanguageService(languageServiceOptions(runtime, notebookDir, project), { log }),
      createDebugger: runtime === "node" || runtime === "deno"
        ? (publish, transformOptions) => new Debugger(publish, transformOptions)
        : undefined,
      readSource,
      kernelFiles: kernelFiles(),
      log,
      exit: () => process.exit(0),
    });
  }

  async run(): Promise<void> {
    const core = this.#core;
    process.on("SIGINT", () => void core.interrupt());
    // Exiting runs the exit hook that kills the runtime (src/children.ts);
    // these signals' default action would skip it (#218).
    for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) {
      process.on(signal, () => {
        core.stopping();
        process.exit(code);
      });
    }
    // A server killed before it could shut the kernel down (#254).
    watchParent(() => {
      log(`parent ${process.env.JPY_PARENT_PID} exited; shutting down`);
      core.stopping();
      process.exit(1);
    });
    // A state dump on stderr, for a kernel that has stopped answering (#237).
    if (process.platform !== "win32") process.on("SIGUSR2", () => void core.logState());
    await core.run();
  }
}
