// Opt-in reports of the kernel's own faults to Sentry (#422).
//
// Off unless the host passes a DSN (--sentry-dsn, or CDP_KERNEL_SENTRY_DSN):
// Ganymede does when its user has opted in. When off, the Sentry SDK isn't
// imported. Cells run in the target process, so an error a cell throws is
// never one of the kernel process's faults; KernelCore reports only errors
// from its own message handling (src/kernel-core.ts).
//
// What is sent follows tlockney/ganymede#384: the error's type, message and
// stack, the kernel's version, the OS and architecture. Each event is cut
// down to those in beforeSend, in this process: no hostname, user, request,
// breadcrumbs, variables or source lines, and paths under the home
// directory start with `~`.

import process from "node:process";
import { arch, homedir, platform, release } from "node:os";
import { fileURLToPath } from "node:url";
import type { ErrorEvent, Event, StackFrame } from "@sentry/core";
import { VERSION } from "./package.ts";

/** The environment variable a host sets to turn reports on. */
export const DSN_ENV = "CDP_KERNEL_SENTRY_DSN";

export interface CrashReporter {
  /** Sends a fault in the kernel's own code; `where` says what it was doing. */
  report(err: unknown, where: string): void;
  /** Resolves false if events were still unsent after `timeoutMs`, or Sentry didn't take one. */
  flush(timeoutMs: number): Promise<boolean>;
}

/** Longest error message sent; the rest is cut. */
const MAX_MESSAGE = 500;

/** Path prefixes rewritten in what is sent, longest first. */
export interface PathRewrites {
  /** The package's directory (path or URL), shown as `cdp-kernel/`. */
  packageRoots: string[];
  /** The home directory, shown as `~`. */
  home: string;
}

function defaultRewrites(): PathRewrites {
  const root = new URL("../", import.meta.url);
  const roots = [root.href];
  if (root.protocol === "file:") roots.push(fileURLToPath(root));
  return { packageRoots: roots, home: homedir() };
}

/** `text` with the package's and home directory's paths shortened. */
export function scrubText(text: string, paths: PathRewrites): string {
  let out = text;
  for (const root of paths.packageRoots) out = out.split(root).join("cdp-kernel/");
  if (paths.home.length > 1) out = out.split(paths.home).join("~");
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE)}…` : out;
}

function scrubFrame(frame: StackFrame, paths: PathRewrites): StackFrame {
  const file = frame.filename ?? frame.abs_path;
  const ours = file !== undefined &&
    paths.packageRoots.some((root) => file.startsWith(root) && !file.slice(root.length).startsWith("node_modules/"));
  // Only where the frame is: no source lines, variables or module names.
  const out: StackFrame = { in_app: ours };
  if (file !== undefined) out.filename = scrubText(file, paths);
  if (frame.function !== undefined) out.function = frame.function;
  if (frame.lineno !== undefined) out.lineno = frame.lineno;
  if (frame.colno !== undefined) out.colno = frame.colno;
  return out;
}

/**
 * The event as sent: only the fields #384 allows, rebuilt rather than
 * deleted from, so a field a later SDK adds isn't sent by default.
 */
export function scrubEvent(event: ErrorEvent, paths: PathRewrites = defaultRewrites()): ErrorEvent {
  const contexts: Event["contexts"] = {};
  for (const key of ["os", "runtime", "device"] as const) {
    if (event.contexts?.[key] !== undefined) contexts[key] = event.contexts[key];
  }
  const out: ErrorEvent = {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    release: event.release,
    environment: event.environment,
    sdk: event.sdk,
    tags: event.tags,
    contexts,
  };
  if (event.message !== undefined) out.message = scrubText(event.message, paths);
  if (event.exception?.values !== undefined) {
    out.exception = {
      values: event.exception.values.map((ex) => ({
        type: ex.type,
        value: ex.value === undefined ? undefined : scrubText(ex.value, paths),
        mechanism: ex.mechanism,
        stacktrace: ex.stacktrace?.frames === undefined
          ? undefined
          : { frames: ex.stacktrace.frames.map((frame) => scrubFrame(frame, paths)) },
      })),
    };
  }
  return out;
}

/**
 * Starts reporting when `dsn` is set, and returns null otherwise or when it
 * can't (an invalid DSN, or the SDK not installed: it is an optional
 * dependency). `runtime` is the target's name, sent as a tag.
 */
export async function startCrashReports(
  dsn: string | undefined,
  runtime: string,
  log: (text: string) => void,
): Promise<CrashReporter | null> {
  if (dsn === undefined || dsn === "") return null;
  let core: typeof import("@sentry/core");
  let server: typeof import("@sentry/core/server");
  try {
    [core, server] = await Promise.all([import("@sentry/core"), import("@sentry/core/server")]);
  } catch (err) {
    log(`crash reports are off: @sentry/core isn't installed (${err instanceof Error ? err.message : err})`);
    return null;
  }
  if (core.makeDsn(dsn) === undefined) {
    log("crash reports are off: the Sentry DSN isn't valid");
    return null;
  }
  const host = process.versions.deno === undefined ? "node" : "deno";
  let failed = false;
  const client = new server.ServerRuntimeClient({
    dsn,
    release: `cdp-kernel@${VERSION}`,
    platform: "node",
    runtime: { name: host, version: process.versions.deno ?? process.versions.node },
    stackParser: core.createStackParser(server.nodeStackLineParser()),
    transport: (options) =>
      core.createTransport(options, async (request) => {
        const res = await fetch(options.url, { method: "POST", body: request.body as BodyInit }).catch((err) => {
          failed = true;
          throw err;
        });
        if (!res.ok) failed = true;
        return {
          statusCode: res.status,
          headers: { "x-sentry-rate-limits": res.headers.get("x-sentry-rate-limits"), "retry-after": res.headers.get("retry-after") },
        };
      }),
    integrations: [],
    sendDefaultPii: false,
    sendClientReports: false,
    traceLifecycle: "static",
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    beforeSend: (event) => scrubEvent(event),
  });
  client.init();

  const scope = new core.Scope();
  scope.setClient(client);
  scope.setContext("os", { name: platform(), version: release() });
  scope.setContext("device", { arch: arch() });
  scope.setContext("runtime", { name: host, version: process.versions.deno ?? process.versions.node });
  scope.setTag("target", runtime);

  const capture = (err: unknown, where: string, handled: boolean): void => {
    const local = scope.clone();
    local.setTag("where", where);
    client.captureException(err, { mechanism: { type: where, handled } }, local);
  };

  // A fault that escaped every handler ends the kernel, as it would without
  // reports, once the report has gone (or two seconds have passed).
  let crashing = false;
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[cdp-kernel] uncaught: ${err instanceof Error ? err.stack : String(err)}\n`);
    if (crashing) return;
    crashing = true;
    capture(err, "uncaught", false);
    void Promise.resolve(client.flush(2_000)).finally(() => process.exit(1));
  });

  return {
    report: (err, where) => capture(err, where, true),
    flush: async (timeoutMs) => await client.flush(timeoutMs) && !failed,
  };
}
