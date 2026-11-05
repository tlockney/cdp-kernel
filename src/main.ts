#!/usr/bin/env node
// cdp-kernel CLI.
//   cdp-kernel install [--runtime node|deno|bun|workerd|celld] [--deno-compat] [--type-strip esbuild|sucrase] [--no-language-service] [--name NAME] [--display NAME]
//   cdp-kernel kernel --runtime node|deno|bun|workerd|celld [--deno-compat] [--type-strip esbuild|sucrase] [--no-language-service] [--sentry-dsn DSN] --conn CONNECTION_FILE
//   cdp-kernel report-test [--sentry-dsn DSN]
//   cdp-kernel list
//   cdp-kernel uninstall [NAME...] [--name NAME] [--all]
//   cdp-kernel version
//
// --deno-compat (Node only) adds a `Deno` namespace for notebooks written for
// `deno jupyter`; see runtime/deno-compat.mjs. --type-strip picks what
// removes cells' types (src/transform.ts). --no-language-service turns off
// typed completion (src/language-service.ts), which costs about 150 MB
// while in use. --sentry-dsn (or CDP_KERNEL_SENTRY_DSN) turns on crash
// reports of the kernel's own faults (src/crash-report.ts); report-test sends
// one, to check a host's setup.

import process from "node:process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Kernel, parseConnectionInfo } from "./kernel.ts";
import type { RuntimeName } from "./target.ts";
import { isTypeStripperName, type TypeStripperName } from "./transform.ts";
import { hostRuntime, kernelArgv, moduleOrigin, VERSION } from "./package.ts";
import { DSN_ENV, startCrashReports } from "./crash-report.ts";

function isRuntime(value: unknown): value is RuntimeName {
  return value === "node" || value === "deno" || value === "bun" || value === "workerd" || value === "celld";
}

function kernelsDir(): string {
  if (process.env.JUPYTER_DATA_DIR) return join(process.env.JUPYTER_DATA_DIR, "kernels");
  if (platform() === "darwin") return join(homedir(), "Library", "Jupyter", "kernels");
  if (platform() === "win32") return join(process.env.APPDATA ?? homedir(), "jupyter", "kernels");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "jupyter", "kernels");
}

// Jupyter's kernel names; anything else could point outside the kernels
// directory.
const KERNEL_NAME = /^[A-Za-z0-9._-]+$/;

function isKernelName(name: string): boolean {
  return KERNEL_NAME.test(name) && name !== "." && name !== "..";
}

function install(
  runtime: RuntimeName,
  denoCompat: boolean,
  typeStrip: TypeStripperName,
  languageService: boolean,
  name: string,
  display: string,
): void {
  if (!isKernelName(name)) {
    console.error(`install: invalid kernelspec name ${JSON.stringify(name)}; use letters, digits, '.', '_' and '-'`);
    process.exit(2);
  }
  const dir = join(kernelsDir(), name);
  mkdirSync(dir, { recursive: true });
  const spec = {
    argv: kernelArgv(hostRuntime(), process.execPath, moduleOrigin(import.meta.url), [
      "kernel",
      "--runtime",
      runtime,
      ...(denoCompat ? ["--deno-compat"] : []),
      ...(typeStrip !== "esbuild" ? ["--type-strip", typeStrip] : []),
      ...(languageService ? [] : ["--no-language-service"]),
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

interface InstalledSpec {
  name: string;
  dir: string;
  runtime: RuntimeName;
  version?: string;
}

// A kernelspec this package wrote: install() always records the runtime in
// metadata and passes the connection file to the kernel subcommand. Other
// kernels' specs in the same directory are left alone.
function readOwnSpec(name: string): InstalledSpec | undefined {
  const dir = join(kernelsDir(), name);
  let spec: { argv?: unknown; metadata?: { runtime?: unknown; version?: unknown } };
  try {
    spec = JSON.parse(readFileSync(join(dir, "kernel.json"), "utf8"));
  } catch {
    return undefined;
  }
  const argv = Array.isArray(spec.argv) ? spec.argv : [];
  const runtime = spec.metadata?.runtime;
  if (!isRuntime(runtime) || !argv.includes("kernel") || !argv.includes("{connection_file}")) return undefined;
  const version = typeof spec.metadata?.version === "string" ? spec.metadata.version : undefined;
  return { name, dir, runtime, version };
}

function installedSpecs(): InstalledSpec[] {
  const root = kernelsDir();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readOwnSpec(entry.name))
    .filter((spec) => spec !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function list(): void {
  const specs = installedSpecs();
  if (specs.length === 0) {
    console.log(`no cdp-kernel kernelspecs in ${kernelsDir()}`);
    return;
  }
  const width = Math.max(...specs.map((s) => s.name.length));
  for (const s of specs) {
    console.log(`${s.name.padEnd(width)}  ${s.runtime.padEnd(7)}  ${(s.version ?? "-").padEnd(7)}  ${s.dir}`);
  }
}

function uninstall(names: string[], all: boolean): void {
  if (all) names = installedSpecs().map((s) => s.name);
  else if (names.length === 0) {
    console.error("uninstall: name the kernelspecs to remove, or pass --all. Installed:");
    list();
    process.exit(2);
  }
  let failed = false;
  for (const name of names) {
    const valid = isKernelName(name);
    const spec = valid ? readOwnSpec(name) : undefined;
    if (!spec) {
      const exists = valid && existsSync(join(kernelsDir(), name));
      console.error(
        exists
          ? `uninstall: ${name} wasn't installed by cdp-kernel; leaving it (use jupyter kernelspec remove)`
          : `uninstall: no kernelspec ${name} in ${kernelsDir()}`,
      );
      failed = true;
      continue;
    }
    rmSync(spec.dir, { recursive: true, force: true });
    console.log(`removed kernelspec ${name} (${spec.dir})`);
  }
  if (all && names.length === 0) console.log(`no cdp-kernel kernelspecs in ${kernelsDir()}`);
  if (failed) process.exit(1);
}

const USAGE =
  "usage: cdp-kernel install [--runtime node|deno|bun|workerd|celld] [--deno-compat] [--type-strip esbuild|sucrase] [--no-language-service] | list | uninstall [NAME...] [--all] | kernel --runtime node|deno|bun|workerd|celld [--sentry-dsn DSN] --conn FILE | report-test [--sentry-dsn DSN] | version";

/** The command line, or exit 2 with the usage when it doesn't parse (an unknown option, a missing value). */
function parseCommandLine() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        runtime: { type: "string", default: "node" },
        conn: { type: "string" },
        name: { type: "string" },
        display: { type: "string" },
        all: { type: "boolean", default: false },
        "deno-compat": { type: "boolean", default: false },
        "type-strip": { type: "string", default: "esbuild" },
        "no-language-service": { type: "boolean", default: false },
        "sentry-dsn": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    console.error(`cdp-kernel: ${err instanceof Error ? err.message.split(". ")[0] : String(err)}`);
    console.error(USAGE);
    process.exit(2);
  }
}

const { positionals, values } = parseCommandLine();
if (values.help || positionals[0] === "help") {
  console.log(USAGE);
  process.exit(0);
}

const runtime = values.runtime;
if (!isRuntime(runtime)) {
  console.error(`unknown runtime ${runtime}; expected node, deno, bun, workerd or celld`);
  process.exit(2);
}

const typeStrip = values["type-strip"];
if (!isTypeStripperName(typeStrip)) {
  console.error(`unknown type stripper ${typeStrip}; expected esbuild or sucrase`);
  process.exit(2);
}

const languageService = values["no-language-service"] !== true;

// Deno targets have the real namespace; the shim is for Node.
const denoCompat = values["deno-compat"] === true && runtime === "node";

// Crash reports are the host's choice (#422). The variable isn't passed on
// to the target, where cells could read it.
const sentryDsn = values["sentry-dsn"] ?? process.env[DSN_ENV];
delete process.env[DSN_ENV];

function logError(text: string): void {
  process.stderr.write(`[cdp-kernel] ${text}\n`);
}

switch (positionals[0]) {
  case "install": {
    const suffix = denoCompat ? "-deno" : "";
    install(
      runtime,
      denoCompat,
      typeStrip,
      languageService,
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
    const reports = await startCrashReports(sentryDsn, runtime, logError);
    const kernel = new Kernel(parseConnectionInfo(readFileSync(values.conn, "utf8")), runtime, {
      denoCompat,
      typeStrip,
      languageService,
      report: reports?.report,
    });
    await kernel.run();
    break;
  }
  case "list":
    list();
    break;
  case "uninstall":
    uninstall([...positionals.slice(1), ...(values.name ? [values.name] : [])], values.all === true);
    break;
  case "report-test": {
    // A host checks its crash report setup with this: it sends one test
    // fault the way a kernel would.
    const reports = await startCrashReports(sentryDsn, runtime, logError);
    if (reports === null) {
      console.error(`report-test: crash reports are off; pass --sentry-dsn or set ${DSN_ENV}`);
      process.exit(2);
    }
    reports.report(new Error("cdp-kernel report-test"), "report-test");
    if (!await reports.flush(10_000)) {
      console.error("report-test: Sentry didn't take the report within 10 s");
      process.exit(1);
    }
    console.log("report-test: sent");
    break;
  }
  case "version":
    console.log(VERSION);
    break;
  default:
    console.error(USAGE);
    process.exit(2);
}
