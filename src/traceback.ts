// Structured tracebacks (#322): an error's stack as frames a frontend can
// render, link to cells and fold, alongside the classic `traceback` lines.
// The payload follows nteract's application/vnd.nteract.traceback+json
// (runtimed/runt, docs/adr/traceback-output-protocol.md): ename, evalue,
// frames with a source window and a `library` flag, and a plain `text`
// rendering. Building it must never cost the user their traceback: callers
// fall back to the classic lines if it throws.
//
// Cells run under a //# sourceURL naming them (cellName), so a frame in a
// cell, including one in a function an earlier cell defined, says which
// cell. Its line goes through the cell's source map, as for the debugger
// (src/sourcemap.ts), so it is the line the user wrote, not the line of the
// stripped JavaScript. Only lines are mapped: a cell frame has no column.
//
// Nothing here imports Node; reading other files' source is the caller's.

import { murmur2 } from "./murmur2.ts";
import type { LineMap } from "./sourcemap.ts";

export const TRACEBACK_MIME = "application/vnd.nteract.traceback+json";

/** Lines of source shown around a frame's line. */
const CONTEXT_BEFORE = 2;
const CONTEXT_AFTER = 2;
/** Longer stacks keep their first and last frames. */
const HEAD_FRAMES = 20;
const TAIL_FRAMES = 10;

/** The //# sourceURL a cell's script runs under while not debugging. */
export function cellName(code: string): string {
  return `$cdpk$cell-${murmur2(code, 0).toString(36)}.ts`;
}

/** A cell that ran: its code, and where the notebook knows it from. */
export interface CellRecord {
  code: string;
  executionCount: number | null;
  cellId: string | null;
}

export interface SourceLine extends Record<string, string | number | boolean> {
  lineno: number;
  source: string;
}

export interface TracebackFrame extends Record<string, unknown> {
  filename: string;
  lineno: number;
  colno?: number;
  name: string;
  library: boolean;
  lines: SourceLine[];
  execution_count?: number;
  cell_id?: string;
}

/** A frame of CDP's exceptionDetails.stackTrace (0-based positions). */
export interface CallFrame {
  url: string;
  lineNumber: number;
  columnNumber: number;
}

/** A frame as parsed from one line of a stack. */
export interface StackFrame {
  name: string;
  file: string;
  line: number | null;
  column: number | null;
}

// V8: "    at fn (file:1:2)", "    at file:1:2", "    at async fn (file:1:2)",
// "    at new Promise (<anonymous>)".
const V8_FRAME = /^\s*at (?:(.*?) \((.*?)(?::(\d+):(\d+))?\)|(.*?)(?::(\d+):(\d+))?)$/;
// JavaScriptCore and SpiderMonkey: "fn@file:1:2", "@file:1:2", "fn@[native code]".
const AT_FRAME = /^([^\s@]*)@(.+?)(?::(\d+):(\d+))?$/;

/** One line of a stack as a frame, or null for a line that isn't one (the message). */
export function parseFrame(text: string): StackFrame | null {
  const v8 = /^\s*at /.test(text) ? V8_FRAME.exec(text) : null;
  if (v8) {
    const named = v8[2] !== undefined;
    const line = named ? v8[3] : v8[6];
    const column = named ? v8[4] : v8[7];
    return {
      name: named ? v8[1] : "",
      file: named ? v8[2] : v8[5],
      line: line === undefined ? null : Number(line),
      column: column === undefined ? null : Number(column),
    };
  }
  const at = !/^\s/.test(text) && text.includes("@") ? AT_FRAME.exec(text) : null;
  if (at) {
    return {
      name: at[1],
      file: at[2],
      line: at[3] === undefined ? null : Number(at[3]),
      column: at[4] === undefined ? null : Number(at[4]),
    };
  }
  return null;
}

/**
 * Frames from packages, runtimes and the kernel itself, which a frontend
 * can dim or fold: a hint, not a boundary.
 */
export function isLibraryFile(file: string, kernelFiles: readonly string[] = []): boolean {
  if (["", "<anonymous>", "native", "[native code]", "unknown"].includes(file)) return true;
  if (/^(?:node|ext|deno|bun|jsr|npm|internal):/.test(file)) return true;
  if (/^https?:\/\/(?:jsr\.io|esm\.sh|cdn\.jsdelivr\.net|unpkg\.com|deno\.land)\//.test(file)) return true;
  const path = file.replaceAll("\\", "/");
  if (path.includes("/node_modules/") || path.includes("/npm/registry.npmjs.org/")) return true;
  return kernelFiles.some((prefix) => path.startsWith(prefix));
}

export interface TracebackSources {
  /** The cell a script name belongs to, if it is one. */
  cell(file: string): (CellRecord & { lines: LineMap | null }) | undefined;
  /** Another file's source, when it can be read. */
  readFile?(file: string): string | undefined;
  /** Path or URL prefixes of the kernel's own runtime files. */
  kernelFiles?: readonly string[];
}

export interface Traceback {
  /** The classic traceback lines, with cell frames pointing at the cell. */
  lines: string[];
  /** The structured payload. */
  payload: Record<string, unknown>;
}

function window(source: string, line: number): SourceLine[] {
  const all = source.split("\n");
  if (all.length > 1 && all[all.length - 1] === "") all.pop();
  const out: SourceLine[] = [];
  for (let n = Math.max(1, line - CONTEXT_BEFORE); n <= Math.min(all.length, line + CONTEXT_AFTER); n++) {
    const entry: SourceLine = { lineno: n, source: all[n - 1].replace(/\r$/, "") };
    if (n === line) entry.highlight = true;
    out.push(entry);
  }
  return out;
}

/** How a cell frame's location reads in the classic traceback. */
function cellLabel(cell: CellRecord): string {
  return cell.executionCount === null ? "cell" : `In[${cell.executionCount}]`;
}

/**
 * `stack` is the error's stack as the target describes it (src/target.ts's
 * describeError), message lines included. `callFrames`, from CDP, name the
 * scripts of frames the stack shows as "<anonymous>": Deno formats stacks
 * itself and doesn't use a script's //# sourceURL.
 */
export function buildTraceback(
  error: { ename: string; evalue: string; stack: string; callFrames?: readonly CallFrame[] },
  sources: TracebackSources,
  execution: { executionCount: number | null; cellId: string | null },
): Traceback {
  const raw = error.stack || `${error.ename}: ${error.evalue}`;
  const lines: string[] = [];
  const frames: TracebackFrame[] = [];
  const callFrames = error.callFrames ?? [];
  let next = 0;
  for (const text of raw.split("\n")) {
    const parsed = parseFrame(text);
    if (parsed === null) {
      lines.push(text);
      continue;
    }
    let file = parsed.file;
    if (parsed.line !== null) {
      // CDP lists only frames with a position, in the same order.
      const at = callFrames.findIndex((frame, i) =>
        i >= next && frame.lineNumber + 1 === parsed.line && frame.columnNumber + 1 === parsed.column
      );
      if (at !== -1) {
        next = at + 1;
        if (file === "<anonymous>" && callFrames[at].url) file = callFrames[at].url;
      }
    }
    const cell = sources.cell(file);
    if (cell !== undefined && parsed.line !== null) {
      // Script lines are 1-based; the map's are 0-based.
      const lineno = cell.lines ? cell.lines.toOriginal(parsed.line - 1) + 1 : parsed.line;
      const frame: TracebackFrame = {
        filename: cellLabel(cell),
        lineno,
        name: parsed.name,
        library: false,
        lines: window(cell.code, lineno),
      };
      if (cell.executionCount !== null) frame.execution_count = cell.executionCount;
      if (cell.cellId !== null) frame.cell_id = cell.cellId;
      frame.source_ref = {
        kind: "notebook_execution",
        ...(cell.executionCount !== null ? { execution_count: cell.executionCount } : {}),
        ...(cell.cellId !== null ? { cell_id: cell.cellId } : {}),
      };
      frames.push(frame);
      const location = `${cellLabel(cell)}:${lineno}`;
      lines.push(rewriteLocation(text, parsed, location));
      continue;
    }
    lines.push(text);
    const library = isLibraryFile(file, sources.kernelFiles);
    const frame: TracebackFrame = {
      filename: file,
      lineno: parsed.line ?? 0,
      name: parsed.name,
      library,
      lines: [],
    };
    if (parsed.column !== null) frame.colno = parsed.column;
    if (!library && parsed.line !== null) {
      const source = sources.readFile?.(file);
      if (source !== undefined) frame.lines = window(source, parsed.line);
    }
    frames.push(frame);
  }
  // What ran the cell (the kernel's evaluator, the runtime's own frames)
  // comes after the cell's last frame and is never the user's.
  const lastCell = frames.findLastIndex((frame) => frame.source_ref !== undefined);
  let end = frames.length;
  while (end > lastCell + 1 && lastCell !== -1 && frames[end - 1].library) end--;
  const kept = clip(frames.slice(0, end));
  const payload: Record<string, unknown> = {
    ename: error.ename,
    evalue: error.evalue,
    language: "typescript",
    frames: kept,
    syntax: null,
    text: lines.join("\n"),
    raw_text: raw,
  };
  if (execution.executionCount !== null || execution.cellId !== null) {
    payload.execution = {
      ...(execution.executionCount !== null ? { execution_count: execution.executionCount } : {}),
      ...(execution.cellId !== null ? { cell_id: execution.cellId } : {}),
    };
  }
  return { lines, payload };
}

function rewriteLocation(text: string, frame: StackFrame, location: string): string {
  const original = `${frame.file}:${frame.line}${frame.column === null ? "" : `:${frame.column}`}`;
  const at = text.lastIndexOf(original);
  return at === -1 ? text : text.slice(0, at) + location + text.slice(at + original.length);
}

function clip(frames: TracebackFrame[]): TracebackFrame[] {
  if (frames.length <= HEAD_FRAMES + TAIL_FRAMES) return frames;
  const omitted = frames.length - HEAD_FRAMES - TAIL_FRAMES;
  return [
    ...frames.slice(0, HEAD_FRAMES),
    { filename: "", lineno: 0, name: `… ${omitted} frames omitted …`, library: true, lines: [] },
    ...frames.slice(-TAIL_FRAMES),
  ];
}
