// Jupyter message handling: shell, control, stdin and iopub, over any
// transport (KernelChannels) and any target (KernelTarget).
//
// Ported from startJupyterKernel in Deno's cli/js/jupyter_kernel.js
// (v2.9.6), which is Copyright 2018-2026 the Deno authors, MIT license.
// The thirteen op_jupyter_* calls into Deno's REPL isolate are replaced by
// a KernelTarget (src/target-api.ts).
//
// Nothing here imports Node: src/kernel.ts wires it to ZeroMQ, the target
// runtimes and the language service, and src/browser/ to a Web Worker.

import { type Header, type JsonObject, type KernelMessage, makeHeader, type OutgoingMessage, PROTOCOL_VERSION } from "./message.ts";
import { Interrupted, type KernelTarget, type TargetEvents, type TargetMessage } from "./target-api.ts";
import type { Debugger } from "./debugger.ts";
import type { CompletionResult } from "./notebook-types.ts";
import {
  type CellTransformOptions,
  CellSyntaxError,
  loadTypeStripper,
  objectLiteralCandidate,
  type TypeStripper,
  type TypeStripperName,
  transformCellWithLines,
} from "./transform.ts";
import { checkIsComplete, codePointToUtf16Index, exprAtCursor, inspectTarget, utf16ToCodePointIndex } from "./text.ts";
import { type HistoryEntry, queryHistory } from "./history.ts";
import type { EvaluateResult } from "./cdp.ts";
import { buildTraceback, type CallFrame, type CellRecord, cellName, TRACEBACK_MIME } from "./traceback.ts";

/** The channels a frontend sends requests on. */
export type ChannelName = "shell" | "control" | "stdin";

/** A request, and which of the frontend's connections it came on. */
export interface Received {
  peer: string;
  msg: KernelMessage;
}

/** How messages reach the kernel and leave it: ZeroMQ (src/zmq-channels.ts), or a page (src/browser/). */
export interface KernelChannels {
  /** Settles once every channel can carry messages. */
  readonly ready: Promise<unknown>;
  /** The next message on a channel; null for one that is dropped (malformed, or unsigned). */
  recv(channel: ChannelName): Promise<Received | null>;
  /** Shell messages received but not yet taken by recv. */
  shellQueued(): number;
  reply(channel: ChannelName, peer: string, msg: OutgoingMessage): void;
  publish(msg: OutgoingMessage): void;
  /** How many frontends listen on stdin. */
  stdinPeers(): number;
  /** To every frontend listening on stdin. */
  sendStdin(msg: OutgoingMessage): void;
}

/** Typed completion and tooltips (src/language-service.ts). */
export interface TypeService {
  reset(): void;
  addCell(code: string): void;
  complete(code: string, cursor: number): Promise<CompletionResult | null>;
  quickInfo(code: string, cursor: number): Promise<string | null>;
}

/** What a KernelCore gets from the process it runs in. */
export interface KernelHost {
  /** The target's name, for the banner and messages. */
  readonly runtime: string;
  readonly version: string;
  /** The TypeScript version cells are checked against; TYPESCRIPT_VERSION if not given. */
  readonly languageVersion?: string;
  readonly channels: KernelChannels;
  launchTarget(events: TargetEvents): Promise<KernelTarget>;
  /** What strips cells' types; esbuild by default (#238). */
  readonly typeStrip?: TypeStripperName | TypeStripper;
  /** A project's transform settings, e.g. a deno.json's JSX options (#13). */
  readonly transform?: CellTransformOptions;
  /** Shown once, in the first cell: e.g. why a project config wasn't used. */
  readonly warning?: string | null;
  readonly types?: TypeService | null;
  /** Returned as `capabilities` in kernel_info_reply, when set: what the host offers cells (#384). */
  readonly capabilities?: JsonObject;
  /** JupyterLab's visual debugger, for targets driven over CDP (#18). */
  createDebugger?(publish: (event: JsonObject) => void, transformOptions: () => CellTransformOptions): Debugger;
  /** A file's source, for the lines around a traceback frame (#322). */
  readSource?(file: string): string | undefined;
  /** Path or URL prefixes of the kernel's own runtime files, whose frames a traceback marks as library code. */
  readonly kernelFiles?: readonly string[];
  log(text: string): void;
  /** After shutdown_reply has gone out. */
  exit(): void;
}

/**
 * kernel_info's language_info.version when the host doesn't know the
 * installed TypeScript's: the major version package.json depends on.
 */
export const TYPESCRIPT_VERSION = "6";

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/**
 * How long interrupt_request may wait on the target before it's answered
 * anyway (#121). Under the 5 s clients allow control requests (#253).
 */
const INTERRUPT_REPLY_WAIT_MS = 1_000;

/** The answer to a target's prompt: a value, or "unwind the cell" (#121). */
interface InputAnswer {
  value: string | null;
  interrupted: boolean;
}

const NO_INPUT: InputAnswer = { value: null, interrupted: false };

/** Cells remembered for tracebacks: a frame can be in a function any earlier cell defined. */
const MAX_CELLS = 1000;

interface ErrorContent extends JsonObject {
  ename: string;
  evalue: string;
  traceback: string[];
}

/** Shell requests other than execute_request, and their reply types. */
const SHELL_REPLIES: Record<string, string> = {
  kernel_info_request: "kernel_info_reply",
  complete_request: "complete_reply",
  is_complete_request: "is_complete_reply",
  inspect_request: "inspect_reply",
  history_request: "history_reply",
  comm_info_request: "comm_info_reply",
};

/** Runtime inspection text without its Type and Signature lines, which the declared type replaces. */
function withoutSignature(text: string): string {
  return text.split("\n").filter((line) => !/^(?:Type|Signature): /.test(line)).join("\n");
}

/** A TypeScript completion kind as a Jupyter completion type (JupyterLab picks its icon by these). */
function jupyterType(kind: string | undefined): string {
  switch (kind) {
    case undefined:
      return "<unknown>";
    case "var":
    case "let":
    case "const":
    case "local var":
    case "parameter":
      return "variable";
    case "local function":
      return "function";
    case "type":
    case "alias":
      return "type";
    default:
      return kind;
  }
}

export class KernelCore {
  readonly #host: KernelHost;
  readonly #channels: KernelChannels;
  readonly #runtime: string;
  readonly #typeStrip: TypeStripperName | TypeStripper;
  #projectWarning: string | null;
  #noticeShownFor: KernelTarget | null = null;
  /** JupyterLab's visual debugger, for targets driven over CDP (#18). */
  readonly #debugger: Debugger | null;
  /** Typed completion from TypeScript's language service (#273). */
  readonly #types: TypeService | null;
  /** Cells run with store_history, for history_request (#10). */
  readonly #history: HistoryEntry[] = [];
  /** Cells that ran, by the name their script ran under, for tracebacks (#322). */
  readonly #cells = new Map<string, CellRecord>();
  readonly #session = crypto.randomUUID();
  #target: KernelTarget | null = null;
  #targetStarting: Promise<KernelTarget> | null = null;
  #executionCount = 0;
  #parent: JsonObject = {};
  #allowStdin = false;
  #executing = false;
  /**
   * stop_on_error (#123): how many of the shell messages queued when a cell
   * failed are still to come, and whether the one being handled is one.
   */
  #abortQueued = 0;
  #aborting = false;
  /** The input_request waiting for its input_reply, if any. */
  #input: { msgId: string; settle: (answer: InputAnswer) => void } | null = null;
  /** An interrupt is waiting on the target. */
  #interrupting = false;
  /** Ends the cell waiting for the target to start, while one is (#336). */
  #interruptStart: (() => void) | null = null;
  /** The shell message being handled, and since when. */
  #handling: { msgType: string; msgId: string; since: number } | null = null;
  // Open comms, for comm_info_request: comm_id -> target_name (#9).
  readonly #comms = new Map<string, string>();
  #shuttingDown = false;

  constructor(host: KernelHost) {
    this.#host = host;
    this.#channels = host.channels;
    this.#runtime = host.runtime;
    this.#typeStrip = host.typeStrip ?? "esbuild";
    this.#projectWarning = host.warning ?? null;
    this.#types = host.types ?? null;
    this.#debugger = host.createDebugger?.((event) => this.#publish("debug_event", event), () => this.#transformOptions()) ?? null;
  }

  async run(): Promise<void> {
    // Start the runtime eagerly so the first cell doesn't pay for it.
    this.#ensureTarget().catch((err) => this.#log(`target failed to start: ${err}`));
    // Transforms are synchronous, so the stripper loads before any cell.
    if (typeof this.#typeStrip === "string") await loadTypeStripper(this.#typeStrip);
    await Promise.all([this.#loop("shell", (m, p) => this.#handleShell(m, p)),
      this.#loop("control", (m, p) => this.#handleControl(m, p)),
      this.#loop("stdin", (m) => this.#handleStdin(m))]);
  }

  /** What SIGINT does: interrupt the cell, or the prompt it waits on. */
  interrupt(): Promise<void> {
    return this.#interrupt();
  }

  /** The process is exiting: a target that exits now isn't reported. */
  stopping(): void {
    this.#shuttingDown = true;
  }

  #log(text: string): void {
    this.#host.log(text);
  }

  /** A state dump, for a kernel that has stopped answering (#237). */
  async logState(): Promise<void> {
    const handling = this.#handling;
    const target = this.#target;
    let targetState: unknown = target === null ? (this.#targetStarting === null ? null : "starting") : target.runtime;
    if (target?.diagnose) targetState = await target.diagnose().catch((err) => `diagnose failed: ${err}`);
    this.#log(`state: ${JSON.stringify({
      shell: handling && { msgType: handling.msgType, msgId: handling.msgId, ms: Date.now() - handling.since },
      queued: this.#channels.shellQueued(),
      executing: this.#executing,
      interrupting: this.#interrupting,
      awaitingInput: this.#input !== null,
      target: targetState,
    })}`);
  }

  #transformOptions(): CellTransformOptions {
    return { ...this.#host.transform, typeStrip: this.#typeStrip };
  }

  // --- comms (#9) ------------------------------------------------------------

  #trackComm(msgType: string, content: JsonObject): void {
    const commId = typeof content.comm_id === "string" ? content.comm_id : null;
    if (commId === null) return;
    if (msgType === "comm_open" && typeof content.target_name === "string") this.#comms.set(commId, content.target_name);
    else if (msgType === "comm_close") this.#comms.delete(commId);
  }

  #commInfo(content: JsonObject): JsonObject {
    const filter = typeof content.target_name === "string" ? content.target_name : null;
    const comms: JsonObject = {};
    for (const [commId, targetName] of this.#comms) {
      if (filter === null || filter === targetName) comms[commId] = { target_name: targetName };
    }
    return comms;
  }

  /** A frontend comm message. The busy/idle status around it is the caller's. */
  async #handleComm(msg: KernelMessage): Promise<void> {
    const type = msg.header.msg_type;
    const commId = String(msg.content.comm_id ?? "");
    const target = await this.#ensureTarget();
    // Kernel messages the handlers send are replies to this message.
    this.#parent = msg.header;
    this.#allowStdin = false;
    this.#executing = true;
    let handled = false;
    try {
      const result = await target.dispatchComm(type, msg.content, msg.metadata, msg.buffers);
      if ("error" in result) {
        const { name, message, stack } = result.error;
        this.#publish("stream", { name: "stderr", text: `Error in ${type} handler: ${stack || `${name}: ${message}`}\n` });
      } else {
        handled = result.handled;
      }
    } catch (err) {
      if (!(err instanceof Interrupted)) throw err;
      this.#publish("stream", { name: "stderr", text: `${type} handler interrupted\n` });
    } finally {
      this.#executing = false;
    }
    await target.flush().catch(() => {});
    if (type === "comm_open") {
      if (handled) {
        this.#comms.set(commId, String(msg.content.target_name ?? ""));
      } else {
        // An unknown target, or a handler that failed: the protocol asks the
        // kernel to close the comm so the frontend doesn't wait on it.
        this.#publish("comm_close", { comm_id: commId, data: {} });
      }
    } else if (type === "comm_close") {
      this.#comms.delete(commId);
    }
  }

  // --- target lifecycle -----------------------------------------------------

  #ensureTarget(): Promise<KernelTarget> {
    if (this.#target) return Promise.resolve(this.#target);
    // Not before the kernel's own ports are bound: a Deno runtime binds its
    // inspector to port 0 within milliseconds of starting and can take a
    // connection-file port the kernel is still binding (#257).
    this.#targetStarting ??= this.#channels.ready.then(() => this.#host.launchTarget(this.#targetEvents())).then(async (target) => {
      // Before any cell runs on it, so breakpoints already apply.
      await this.#debugger?.attachTarget(target.debug ?? null);
      this.#target = target;
      this.#targetStarting = null;
      return target;
    }, (err) => {
      this.#targetStarting = null;
      throw err;
    });
    return this.#targetStarting;
  }

  /**
   * The target for a cell. An interrupt while it starts ends the cell; the
   * start goes on, bounded by the target's own deadline, for the next one (#336).
   */
  async #targetForCell(): Promise<KernelTarget> {
    if (this.#target) return this.#target;
    const interrupted = new Promise<never>((_, reject) => {
      this.#interruptStart = () => reject(new Interrupted("Execution interrupted"));
    });
    try {
      return await Promise.race([this.#ensureTarget(), interrupted]);
    } finally {
      this.#interruptStart = null;
    }
  }

  #targetEvents(): TargetEvents {
    return {
      stream: (name, text) => this.#publish("stream", { name, text }),
      message: (msg) => void this.#onTargetMessage(msg).catch((err) => this.#log(`error handling target message: ${err}`)),
      exit: (code, note) => {
        this.#target = null;
        // What its cells declared died with it.
        this.#types?.reset();
        // Its prompt, if any, died with it; a late reply is dropped.
        this.#input = null;
        void this.#debugger?.attachTarget(null);
        if (!this.#shuttingDown) {
          const text = note ?? `[cdp-kernel] ${this.#runtime} exited (${code}); restarting on next cell`;
          this.#publish("stream", { name: "stderr", text: `\n${text}\n` });
        }
      },
    };
  }

  async #onTargetMessage(msg: TargetMessage): Promise<void> {
    if (msg.kind === "iopub") {
      this.#trackComm(msg.msg_type, msg.content);
      this.#publish(msg.msg_type, msg.content, {
        metadata: msg.metadata,
        buffers: msg.buffers.map(fromBase64),
      });
      return;
    }
    // The answer goes to the target that asked, not one started since.
    const target = this.#target;
    let answer = NO_INPUT;
    try {
      answer = await this.#requestInput(msg.prompt, msg.password);
    } finally {
      // Always answer exactly once so the target's blocking read returns.
      if (target !== null && target === this.#target) target.replyInput(answer.value, answer.interrupted);
    }
  }

  async #interrupt(): Promise<void> {
    // A target blocked reading its prompt's answer can't run
    // terminateExecution, and would never answer it. Make the prompt throw
    // instead, which ends the cell (#121).
    const input = this.#input;
    if (input !== null) {
      this.#input = null;
      input.settle({ value: null, interrupted: true });
      return;
    }
    if (this.#interruptStart !== null) {
      this.#interruptStart();
      return;
    }
    if (!this.#target || !this.#executing) return;
    this.#interrupting = true;
    try {
      await this.#target.interrupt();
    } finally {
      this.#interrupting = false;
    }
  }

  // --- messaging --------------------------------------------------------------

  #message(
    msgType: string,
    content: JsonObject,
    parentHeader: JsonObject,
    extra: { header?: Header; metadata?: JsonObject; buffers?: Uint8Array[] } = {},
  ): OutgoingMessage {
    return {
      header: extra.header ?? makeHeader(this.#session, msgType),
      parentHeader,
      metadata: extra.metadata ?? {},
      content,
      buffers: extra.buffers ?? [],
    };
  }

  #publish(msgType: string, content: JsonObject, extra: { metadata?: JsonObject; buffers?: Uint8Array[]; parent?: JsonObject } = {}): void {
    this.#channels.publish(this.#message(msgType, content, extra.parent ?? this.#parent, extra));
  }

  #status(state: "busy" | "idle", parent: JsonObject): void {
    this.#publish("status", { execution_state: state }, { parent });
  }

  #reply(channel: ChannelName, peer: string, request: KernelMessage, msgType: string, content: JsonObject): void {
    this.#channels.reply(channel, peer, this.#message(msgType, content, request.header));
  }

  async #loop(channel: ChannelName, handle: (msg: KernelMessage, peer: string) => Promise<void>): Promise<void> {
    while (!this.#shuttingDown) {
      const received = await this.#channels.recv(channel);
      // Before the drop below: shellQueued() counted this message too, so
      // a dropped one takes its own abort slot, not a queued cell's (#340).
      if (channel === "shell") {
        this.#aborting = this.#abortQueued > 0;
        if (this.#aborting) this.#abortQueued--;
      }
      // Malformed, or on ZeroMQ unsigned or forged: dropped, as in Deno.
      if (received === null) continue;
      const { peer, msg } = received;
      try {
        if (channel === "shell") this.#handling = { msgType: msg.header.msg_type, msgId: msg.header.msg_id, since: Date.now() };
        await handle(msg, peer);
      } catch (err) {
        this.#log(`error handling message: ${err instanceof Error ? err.stack : err}`);
      } finally {
        if (channel === "shell") this.#handling = null;
      }
    }
  }

  #kernelInfo(): JsonObject {
    const versions = this.#target?.versions;
    return {
      status: "ok",
      protocol_version: PROTOCOL_VERSION,
      implementation: "cdp-kernel",
      implementation_version: this.#host.version,
      language_info: {
        name: "typescript",
        version: this.#host.languageVersion ?? TYPESCRIPT_VERSION,
        mimetype: "text/x.typescript",
        file_extension: ".ts",
        pygments_lexer: "typescript",
        codemirror_mode: "typescript",
        nbconvert_exporter: "script",
      },
      // The runtime's versions are known once it is up.
      banner: versions ? `cdp-kernel on ${this.#runtime} ${versions.runtime} (${versions.engine || "?"})` : `cdp-kernel on ${this.#runtime}`,
      help_links: [],
      debugger: this.#debugger !== null,
      // What current ipykernel advertises; JupyterLab itself goes by the
      // kernelspec's metadata.debugger.
      supported_features: this.#debugger !== null ? ["debugger"] : [],
      ...(this.#host.capabilities ? { capabilities: this.#host.capabilities } : {}),
    };
  }

  // --- control channel ------------------------------------------------------

  async #handleControl(msg: KernelMessage, peer: string): Promise<void> {
    // Every request is wrapped in busy/idle, as on shell (#124). JupyterLab
    // treats a debug request as done only once the kernel reports idle for
    // it. (Jupyter Server leaves debug_request out of the kernel's status.)
    this.#status("busy", msg.header);
    try {
      await this.#controlRequest("control", msg, peer);
    } finally {
      this.#status("idle", msg.header);
    }
  }

  /** Control requests; shutdown and interrupt may also arrive on shell (#124). */
  async #controlRequest(channel: ChannelName, msg: KernelMessage, peer: string): Promise<void> {
    switch (msg.header.msg_type) {
      case "kernel_info_request":
        this.#reply(channel, peer, msg, "kernel_info_reply", this.#kernelInfo());
        break;
      case "interrupt_request":
        // Answer even if the target doesn't (#121); the interrupt goes on.
        await Promise.race([
          this.#interrupt().catch((err) => this.#log(`interrupt failed: ${err}`)),
          new Promise((r) => setTimeout(r, INTERRUPT_REPLY_WAIT_MS)),
        ]);
        this.#reply(channel, peer, msg, "interrupt_reply", { status: "ok" });
        break;
      case "debug_request": {
        let reply: JsonObject;
        if (this.#debugger === null) {
          reply = { type: "response", request_seq: msg.content.seq, command: msg.content.command, success: false, message: `${this.#runtime} targets have no debugger`, body: {} };
        } else {
          // Everything but debugInfo talks to the target, so make sure there is one.
          if (msg.content.command !== "debugInfo") await this.#ensureTarget().catch(() => null);
          reply = await this.#debugger.handle(msg.content) as JsonObject;
        }
        this.#reply(channel, peer, msg, "debug_reply", reply);
        break;
      }
      case "shutdown_request": {
        const restart = msg.content.restart === true;
        this.#reply(channel, peer, msg, "shutdown_reply", { status: "ok", restart });
        this.#shuttingDown = true;
        this.#target?.kill();
        // Frontends spawn a fresh kernel even on restart; exit after the
        // reply has had a moment to flush (denoland/deno#20556).
        setTimeout(() => this.#host.exit(), 100);
        break;
      }
    }
  }

  // --- shell channel ----------------------------------------------------------

  async #handleShell(msg: KernelMessage, peer: string): Promise<void> {
    const type = msg.header.msg_type;
    if (type === "execute_request") return this.#execute(msg, peer);
    this.#status("busy", msg.header);
    try {
      switch (type) {
        case "kernel_info_request":
          // Without waiting for the runtime: clients probe with kernel_info
          // while it starts, and re-send until answered (#253).
          this.#reply("shell", peer, msg, "kernel_info_reply", this.#kernelInfo());
          break;
        case "complete_request":
          this.#reply("shell", peer, msg, "complete_reply", await this.#complete(msg));
          break;
        case "is_complete_request":
          this.#reply("shell", peer, msg, "is_complete_reply", checkIsComplete(String(msg.content.code ?? "")));
          break;
        case "inspect_request":
          this.#reply("shell", peer, msg, "inspect_reply", await this.#inspect(msg));
          break;
        case "history_request":
          this.#reply("shell", peer, msg, "history_reply", { status: "ok", history: queryHistory(this.#history, msg.content) });
          break;
        case "comm_info_request":
          this.#reply("shell", peer, msg, "comm_info_reply", { status: "ok", comms: this.#commInfo(msg.content) });
          break;
        case "comm_open":
        case "comm_msg":
        case "comm_close":
          await this.#handleComm(msg);
          break;
        case "shutdown_request":
        case "interrupt_request":
          // Deprecated on shell, but still allowed, and ipykernel takes them.
          await this.#controlRequest("shell", msg, peer);
          break;
        default:
          this.#log(`ignoring unknown shell message ${type}`);
      }
    } catch (err) {
      // E.g. the runtime failed to launch. Answer anyway, so the frontend
      // doesn't wait on the request forever (#125).
      const replyType = SHELL_REPLIES[type];
      if (replyType !== undefined) {
        const name = err instanceof Error ? err.name : "Error";
        const message = err instanceof Error ? err.message : String(err);
        const error: ErrorContent = { ename: name, evalue: message, traceback: [`${name}: ${message}`] };
        this.#reply("shell", peer, msg, replyType, { status: "error", ...error });
      }
      throw err;
    } finally {
      this.#status("idle", msg.header);
    }
  }

  /**
   * The tooltip (Shift-Tab) for the name at the cursor (#10): its declared
   * type, signature and JSDoc when the language service knows them (#274),
   * then what the runtime finds.
   */
  async #inspect(msg: KernelMessage): Promise<JsonObject> {
    const code = String(msg.content.code ?? "");
    const cursorCp = typeof msg.content.cursor_pos === "number"
      ? msg.content.cursor_pos
      : utf16ToCodePointIndex(code, code.length);
    const cursor = codePointToUtf16Index(code, cursorCp);
    const path = inspectTarget(code, cursor);
    const detail = msg.content.detail_level === 1 ? 1 : 0;
    const [runtime, typed] = await Promise.all([
      path === null ? null : (async () => (await this.#ensureTarget()).inspect(path, detail))(),
      this.#types?.quickInfo(code, cursor) ?? null,
    ]);
    const text = typed === null ? runtime : runtime === null ? typed : `${typed}\n\n${withoutSignature(runtime)}`;
    return text === null
      ? { status: "ok", found: false, data: {}, metadata: {} }
      : { status: "ok", found: true, data: { "text/plain": text }, metadata: {} };
  }

  async #complete(msg: KernelMessage): Promise<JsonObject> {
    const code = String(msg.content.code ?? "");
    const cursorCp = typeof msg.content.cursor_pos === "number"
      ? msg.content.cursor_pos
      : utf16ToCodePointIndex(code, code.length);
    const cursor = codePointToUtf16Index(code, cursorCp);
    // Both at once: the language service may not answer within its budget.
    const [runtime, typed] = await Promise.all([
      this.#runtimeCompletions(code, cursor),
      this.#types?.complete(code, cursor) ?? null,
    ]);
    // Declared types first, then what only the runtime knows (a property
    // added at runtime, a global defined by a library).
    let matches = runtime.matches;
    let start = runtime.start;
    const kinds = new Map<string, string>();
    if (typed !== null && typed.start === runtime.start) {
      for (const entry of typed.entries) kinds.set(entry.name, entry.kind);
      matches = [...kinds.keys(), ...runtime.matches.filter((name) => !kinds.has(name))];
    } else if (typed !== null && typed.entries.length > 0 && runtime.matches.length === 0) {
      // An expression the runtime can't complete, e.g. inside a call.
      for (const entry of typed.entries) kinds.set(entry.name, entry.kind);
      matches = [...kinds.keys()];
      start = typed.start;
    }
    const cursorStart = utf16ToCodePointIndex(code, start);
    return {
      status: "ok",
      matches,
      cursor_start: cursorStart,
      cursor_end: cursorCp,
      metadata: kinds.size === 0 ? {} : {
        // JupyterLab shows each match's type as an icon.
        _jupyter_types_experimental: matches.map((text) => ({
          start: cursorStart,
          end: cursorCp,
          text,
          type: jupyterType(kinds.get(text)),
        })),
      },
    };
  }

  /** Completion from the runtime's values: property names, globals, lexical names. */
  async #runtimeCompletions(code: string, cursor: number): Promise<{ matches: string[]; start: number }> {
    const expr = exprAtCursor(code, cursor);
    const target = await this.#ensureTarget();
    const dot = expr.lastIndexOf(".");
    if (dot !== -1) {
      const prefix = expr.slice(dot + 1);
      const matches = (await target.propertyNames(expr.slice(0, dot)))
        .filter((name) => name.startsWith(prefix) && !name.startsWith("Symbol("));
      return { matches, start: cursor - prefix.length };
    }
    const names = new Set([...(await target.propertyNames("globalThis")), ...(await target.lexicalNames())]);
    const matches = [...names].filter((name) => name.startsWith(expr) && !name.startsWith("__cdpk")).sort();
    return { matches, start: cursor - expr.length };
  }

  async #requestInput(prompt: string, password: boolean): Promise<InputAnswer> {
    // The target asked while an interrupt was already waiting on it.
    if (this.#interrupting) return { value: null, interrupted: true };
    const parent = this.#parent;
    if (!this.#allowStdin || typeof parent.msg_id !== "string") return NO_INPUT;
    if (this.#channels.stdinPeers() === 0) await new Promise((r) => setTimeout(r, 100));
    if (this.#channels.stdinPeers() === 0) return NO_INPUT;
    const header = makeHeader(this.#session, "input_request");
    const answer = new Promise<InputAnswer>((settle) => (this.#input = { msgId: header.msg_id, settle }));
    this.#channels.sendStdin(this.#message("input_request", { prompt, password }, parent, { header }));
    return answer;
  }

  /** stdin carries only input_replys. */
  async #handleStdin(reply: KernelMessage): Promise<void> {
    if (reply.header.msg_type !== "input_reply") return;
    const input = this.#input;
    // A reply with nothing waiting is late (its prompt was interrupted), and
    // one naming another request is for an earlier prompt: drop both rather
    // than answer the next prompt with them (#121). Some clients
    // (jupyter_client's input()) send no parent header, so only a present
    // one is checked.
    if (input === null) return;
    const parentId = reply.parentHeader.msg_id;
    if (typeof parentId === "string" && parentId !== "" && parentId !== input.msgId) return;
    this.#input = null;
    input.settle({ value: typeof reply.content.value === "string" ? reply.content.value : null, interrupted: false });
  }

  /**
   * The structured form of a cell's error, and the classic lines with cell
   * frames pointing at the cell's own lines. Null, with `error` as it was,
   * if it can't be built: the user must always get the traceback.
   */
  #structuredTraceback(error: ErrorContent, stack: string, callFrames: CallFrame[] | undefined, cell: CellRecord): JsonObject | null {
    try {
      const traceback = buildTraceback({ ename: error.ename, evalue: error.evalue, stack, callFrames }, {
        cell: (file) => {
          const record = this.#cells.get(file);
          if (record === undefined) return undefined;
          let lines = null;
          try {
            lines = transformCellWithLines(record.code, this.#transformOptions()).lines;
          } catch {
            // A cell that ran transforms again; if not, its lines go unmapped.
          }
          return { ...record, lines };
        },
        readFile: (file) => this.#host.readSource?.(file),
        kernelFiles: this.#host.kernelFiles,
      }, cell);
      error.traceback = traceback.lines;
      return traceback.payload as JsonObject;
    } catch (err) {
      this.#host.log(`structured traceback failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Remembers the cell under the name its script runs as. */
  #remember(name: string, cell: CellRecord): void {
    this.#cells.delete(name);
    this.#cells.set(name, cell);
    if (this.#cells.size > MAX_CELLS) this.#cells.delete(this.#cells.keys().next().value!);
  }

  async #evaluateCell(target: KernelTarget, cell: CellRecord): Promise<EvaluateResult> {
    const code = cell.code;
    // Object-literal wrapping (Deno's evaluate_line_with_object_wrapping):
    // try `({ ... })` first and fall back to the code as written.
    // While debugging, cells carry the path JupyterLab gave them and keep a
    // line map, so breakpoints bind and frames point at the cell (#18).
    const debugging = this.#debugger?.started === true && target.debug !== undefined;
    // Otherwise each cell's script is named for its code, so a traceback
    // can tell which cell a frame is in (#322).
    const name = debugging && this.#debugger ? this.#debugger.pathFor(code) : cellName(code);
    this.#remember(name, cell);
    const transform = (source: string) =>
      debugging && this.#debugger
        ? this.#debugger.cellScript(code, source)
        : `${target.transform(source, this.#transformOptions())}\n//# sourceURL=${name}`;
    const wrapped = objectLiteralCandidate(code);
    if (wrapped !== null) {
      try {
        const result = await target.evaluate(transform(wrapped));
        if (!result.exceptionDetails) return result;
      } catch (err) {
        if (!(err instanceof CellSyntaxError)) throw err;
      }
    }
    return target.evaluate(transform(code));
  }

  /** execute_request's user_expressions, each as its value's MIME bundle or the error it threw (#340). */
  async #userExpressions(target: KernelTarget, expressions: unknown): Promise<JsonObject> {
    const results: JsonObject = {};
    if (typeof expressions !== "object" || expressions === null) return results;
    for (const [name, expression] of Object.entries(expressions)) {
      results[name] = await this.#userExpression(target, String(expression));
    }
    return results;
  }

  async #userExpression(target: KernelTarget, expression: string): Promise<JsonObject> {
    try {
      // On their own lines, so a trailing line comment can't swallow the paren.
      const source = `(\n${expression}\n)`;
      const result = await target.evaluate(`${target.transform(source, this.#transformOptions())}\n//# sourceURL=$cdpk$user-expression.ts`);
      if (result.exceptionDetails) {
        const exception = result.exceptionDetails.exception;
        const described = exception
          ? await target.describeError(exception)
          : { name: "Error", message: result.exceptionDetails.text, stack: "" };
        return {
          status: "error",
          ename: described.name || "Error",
          evalue: described.message,
          traceback: (described.stack || `${described.name}: ${described.message}`).split("\n"),
        };
      }
      return { status: "ok", data: await target.format(result.result) as JsonObject, metadata: {} };
    } catch (err) {
      const ename = err instanceof CellSyntaxError ? "SyntaxError" : err instanceof Interrupted ? "Interrupted" : "Error";
      const evalue = err instanceof Error ? err.message : String(err);
      return { status: "error", ename, evalue, traceback: [`${ename}: ${evalue}`] };
    }
  }

  async #execute(msg: KernelMessage, peer: string): Promise<void> {
    const parent = msg.header;
    if (this.#aborting) {
      // Queued behind a failed cell: not run, not counted (#123).
      this.#status("busy", parent);
      this.#reply("shell", peer, msg, "execute_reply", { status: "aborted" });
      this.#status("idle", parent);
      return;
    }
    const code = String(msg.content.code ?? "");
    const silent = msg.content.silent === true;
    if (!silent && msg.content.store_history !== false) {
      this.#executionCount++;
      this.#history.push({ line: this.#executionCount, input: code });
    }
    const count = this.#executionCount;
    this.#parent = parent;
    this.#allowStdin = msg.content.allow_stdin === true;
    this.#status("busy", parent);
    // Silent requests broadcast nothing on iopub but status (#124).
    if (!silent) this.#publish("execute_input", { code, execution_count: count });
    if (this.#projectWarning !== null) {
      // Shown once, in the first cell, where the user will see it.
      this.#publish("stream", { name: "stderr", text: `[cdp-kernel] ${this.#projectWarning}\n` });
      this.#projectWarning = null;
    }

    let error: ErrorContent | null = null;
    let userExpressions: JsonObject = {};
    // nteract's structured traceback, sent as the error message's metadata (#322).
    let structured: JsonObject | null = null;
    this.#executing = true;
    try {
      const target = await this.#targetForCell();
      if (target.notice !== undefined && this.#noticeShownFor !== target) {
        // Once per target, in the first cell it runs.
        this.#noticeShownFor = target;
        this.#publish("stream", { name: "stderr", text: `${target.notice}\n` });
      }
      const cell: CellRecord = {
        code,
        executionCount: silent || msg.content.store_history === false ? null : count,
        cellId: typeof msg.metadata.cellId === "string" ? msg.metadata.cellId : null,
      };
      const result = await this.#evaluateCell(target, cell);
      // It ran, so its declarations exist, even if it threw part way.
      this.#types?.addCell(code);
      if (result.exceptionDetails) {
        const exception = result.exceptionDetails.exception;
        const described = exception
          ? await target.describeError(exception)
          : { name: "Error", message: result.exceptionDetails.text, stack: "" };
        error = {
          ename: described.name || "Error",
          evalue: described.message,
          traceback: (described.stack || `${described.name}: ${described.message}`).split("\n"),
        };
        structured = this.#structuredTraceback(error, described.stack, result.exceptionDetails.stackTrace?.callFrames, cell);
      } else if (!silent && result.result.type !== "undefined") {
        await target.broadcastResult(count, result.result);
      }
      // As in ipykernel: only after a cell that succeeded (#340).
      if (!result.exceptionDetails) userExpressions = await this.#userExpressions(target, msg.content.user_expressions);
      await target.flush();
    } catch (err) {
      if (err instanceof CellSyntaxError) {
        // Deno reports these as an opaque "Execution failed".
        error = { ename: "SyntaxError", evalue: err.message, traceback: [`SyntaxError: ${err.message}`] };
      } else if (err instanceof Interrupted) {
        error = { ename: "Interrupted", evalue: "Execution interrupted", traceback: ["Execution interrupted"] };
        await this.#target?.flush().catch(() => {});
      } else {
        const message = err instanceof Error ? err.message : String(err);
        error = { ename: "KernelError", evalue: message, traceback: [message] };
      }
    } finally {
      this.#executing = false;
    }
    // The result and error are shown: nothing refers to them any more (#286).
    await this.#target?.releaseResults?.();

    if (error) {
      if (!silent && msg.content.stop_on_error !== false) {
        // Abort what was queued behind this cell (JupyterLab's Run All sends
        // every cell at once), but nothing sent after the client sees the
        // error. A macrotask first lets bytes already received be parsed.
        await new Promise((r) => setTimeout(r, 0));
        this.#abortQueued = this.#channels.shellQueued();
      }
      this.#publish("error", error, structured ? { metadata: { [TRACEBACK_MIME]: structured } } : {});
      this.#reply("shell", peer, msg, "execute_reply", { status: "error", execution_count: count, ...error });
    } else {
      this.#reply("shell", peer, msg, "execute_reply", {
        status: "ok",
        execution_count: count,
        payload: [],
        user_expressions: userExpressions,
      });
    }
    this.#status("idle", parent);
  }
}
