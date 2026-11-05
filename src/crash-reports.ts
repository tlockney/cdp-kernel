// Opt-in reports of faults in cdp-kernel's own code (#422,
// tlockney/ganymede#384), sent to Sentry's cdp-kernel project.
//
// Off unless the host sets CDP_KERNEL_CRASH_REPORTS=1, which Ganymede does
// when its user opted in. While off nothing here runs: no handler, no
// request. Errors from user cells never come through here: the target
// reports those to KernelCore as exception details, and KernelCore answers
// them as cell errors. What does: an exception that escapes a message
// handler, the target-message handler, or the process.
//
// No Sentry SDK: an event is a small JSON envelope, posted with fetch.
// That keeps the npm and JSR packages free of a dependency and its
// install-time cost for everyone who never opts in.
//
// Sent: the error's type, message (home directories as `~`, URLs cut to
// their path, 300 characters at most) and stack (frames in cdp-kernel's
// own files by their path in the package; others by name only), the
// version, host and target runtime, OS and architecture. Not sent: cell
// source, outputs, variables, file paths outside the package, env vars,
// host name.

import process from "node:process";
import { arch, platform, release } from "node:os";
import { hostRuntime, VERSION } from "./package.ts";

/** The cdp-kernel project's DSN. It only lets a client send events. */
export const DSN = "https://91c2265acb5b0b0115914a43375be9ba@o4512380800598016.ingest.us.sentry.io/4512380976168960";

/** At most this many reports per process: a fault in a loop sends a few, not thousands. */
const MAX_REPORTS = 10;
const MAX_MESSAGE = 300;
const SEND_TIMEOUT_MS = 5000;

export interface Frame {
  filename: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

/** `text` with home directories as `~`, URLs cut to their path, and at most MAX_MESSAGE characters. */
export function scrubText(text: string): string {
  const out = text
    .replace(/\b(?:https?|wss?|file):\/\/[^\s/'"`)]*([^\s?#'"`)]*)(?:[?#][^\s'"`)]*)?/g, "$1")
    .replace(/(?:\/Users|\/home)\/[^/\s'"`)]+/g, "~")
    .replace(/[A-Za-z]:\\Users\\[^\\\s'"`)]+/g, "~");
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE)}…` : out;
}

/**
 * A frame's file as cdp-kernel's own, `app:///src/kernel-core.ts`, or null
 * when it isn't: its path from the package root (`src/`, `dist/` or
 * `runtime/` and below), wherever the package is installed.
 */
export function packageFile(file: string): string | null {
  const path = file.replace(/^file:\/\//, "").replaceAll("\\", "/");
  // From npm, from JSR (jsr.io/@tlockney/cdp-kernel/<version>/src/…), or a checkout.
  const match = /(?:^|\/)(?:@tlockney\/cdp-kernel(?:\/[^/]+)?|cdp-kernel)\/((?:src|dist|runtime)\/[^?#]+)$/.exec(path);
  return match ? `app:///${match[1]}` : null;
}

const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;

/** V8's stack lines as Sentry frames, oldest first. Files outside the package are dropped to `<other>`. */
export function parseStack(stack: string | undefined): Frame[] {
  const frames: Frame[] = [];
  for (const line of (stack ?? "").split("\n")) {
    const m = V8_FRAME.exec(line);
    if (!m) continue;
    const [, fn, file, lineno, colno] = m;
    const own = packageFile(file);
    const internal = file.startsWith("node:") || file.startsWith("ext:");
    frames.push({
      filename: own ?? (internal ? file : "<other>"),
      function: fn,
      lineno: own || internal ? Number(lineno) : undefined,
      colno: own || internal ? Number(colno) : undefined,
      in_app: own !== null,
    });
  }
  return frames.reverse();
}

export interface ReportContext {
  /** Where it was caught, e.g. `shell handler`. */
  where: string;
  /** The target runtime: node, deno, bun, workerd or celld. */
  target?: string;
}

/** The Sentry event for `err`. Pure but for the clock and the ids. */
export function buildEvent(err: unknown, context: ReportContext): Record<string, unknown> {
  const error = err instanceof Error ? err : new Error(String(err));
  return {
    event_id: crypto.randomUUID().replaceAll("-", ""),
    timestamp: Date.now() / 1000,
    platform: "node",
    level: "error",
    release: `cdp-kernel@${VERSION}`,
    environment: "production",
    tags: { where: context.where, host: hostRuntime(), ...(context.target ? { target: context.target } : {}) },
    contexts: {
      os: { name: platform(), kernel_version: release() },
      device: { arch: arch() },
      runtime: { name: hostRuntime(), version: process.versions.deno ?? process.versions.node },
    },
    exception: {
      values: [{
        type: error.name,
        value: scrubText(error.message),
        stacktrace: { frames: parseStack(error.stack) },
        mechanism: { type: context.where, handled: context.where !== "uncaught" },
      }],
    },
  };
}

interface Dsn {
  key: string;
  envelope: string;
}

function parseDsn(dsn: string): Dsn {
  const url = new URL(dsn);
  const project = url.pathname.replace(/^\//, "");
  return { key: url.username, envelope: `${url.protocol}//${url.host}/api/${project}/envelope/` };
}

export interface Reporter {
  /** Sends a report; resolves once sent or given up on. Never throws. */
  report(err: unknown, where: string): Promise<void>;
}

/**
 * The reporter for this process: a real one when CDP_KERNEL_CRASH_REPORTS
 * is `1`, otherwise one that does nothing. `send` is for tests.
 */
export function crashReporter(
  options: { env?: Record<string, string | undefined>; target?: string; send?: typeof fetch } = {},
): Reporter | null {
  const env = options.env ?? process.env;
  if (env.CDP_KERNEL_CRASH_REPORTS !== "1") return null;
  const dsn = parseDsn(env.CDP_KERNEL_SENTRY_DSN || DSN);
  const send = options.send ?? fetch;
  let sent = 0;
  return {
    async report(err, where) {
      if (sent >= MAX_REPORTS) return;
      sent++;
      try {
        const event = buildEvent(err, { where, target: options.target });
        const body = [
          JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() }),
          JSON.stringify({ type: "event" }),
          JSON.stringify(event),
        ].join("\n");
        await send(dsn.envelope, {
          method: "POST",
          headers: {
            "content-type": "application/x-sentry-envelope",
            "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${dsn.key}, sentry_client=cdp-kernel/${VERSION}`,
          },
          body,
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch {
        // Reporting must never take the kernel down.
      }
    },
  };
}

/**
 * Reports an exception that would end the process, then ends it as Node
 * would have: the stack on stderr and exit code 1. Only installed when
 * reporting is on, so with it off a crash is exactly as before. An
 * unhandled rejection arrives here too (Node's default `throw` mode).
 */
export function reportUncaught(reporter: Reporter): void {
  let ending = false;
  process.on("uncaughtException", (err) => {
    if (ending) return;
    ending = true;
    console.error(err instanceof Error ? err.stack ?? String(err) : err);
    void reporter.report(err, "uncaught").finally(() => process.exit(1));
  });
}
