// Jupyter message handling: shell, control, stdin and iopub.
//
// Ported from startJupyterKernel in Deno's cli/js/jupyter_kernel.js
// (v2.9.6), which is Copyright 2018-2026 the Deno authors, MIT license.
// The thirteen op_jupyter_* calls into Deno's REPL isolate are replaced by
// a Target driven over CDP (src/target.ts).

import { Buffer } from "node:buffer";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { decodeMessage, encodeMessage, type JsonObject, makeHeader, type Message, PROTOCOL_VERSION, verify } from "./wire.ts";
import { PubSocket, RouterSocket, startHeartbeat } from "./zmtp.ts";
import { Interrupted, type KernelTarget, type RuntimeName, Target, type TargetEvents, type TargetMessage } from "./target.ts";
import { BunTarget } from "./bun-target.ts";
import { Debugger } from "./debugger.ts";
import { WorkerdTarget } from "./workerd-target.ts";
import { launchCelld } from "./celld-target.ts";
import {
  type CellTransformOptions,
  CellSyntaxError,
  loadTypeStripper,
  objectLiteralCandidate,
  type TypeStripper,
  type TypeStripperName,
} from "./transform.ts";
import { type DenoProject, loadDenoProject } from "./deno-config.ts";
import { checkIsComplete, codePointToUtf16Index, exprAtCursor, inspectTarget, utf16ToCodePointIndex } from "./text.ts";
import { type HistoryEntry, queryHistory } from "./history.ts";
import type { EvaluateResult } from "./cdp.ts";
import { VERSION } from "./package.ts";

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

/** How long interrupt_request may wait on the target before it's answered anyway (#121). */
const INTERRUPT_REPLY_WAIT_MS = 5_000;

/** The answer to a target's prompt: a value, or "unwind the cell" (#121). */
interface InputAnswer {
  value: string | null;
  interrupted: boolean;
}

const NO_INPUT: InputAnswer = { value: null, interrupted: false };

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

export class Kernel {
  readonly #conn: ConnectionInfo;
  readonly #runtime: RuntimeName;
  readonly #denoCompat: boolean;
  readonly #typeStrip: TypeStripperName | TypeStripper;
  // A Deno target in a Deno project uses its config (#13).
  readonly #project: DenoProject | null;
  #projectWarning: string | null = null;
  #noticeShownFor: KernelTarget | null = null;
  /** JupyterLab's visual debugger, for targets driven over CDP (#18). */
  readonly #debugger: Debugger | null;
  /** Cells run with store_history, for history_request (#10). */
  readonly #history: HistoryEntry[] = [];
  readonly #session = randomUUID();
  readonly #shell: RouterSocket;
  readonly #control: RouterSocket;
  readonly #stdin: RouterSocket;
  readonly #iopub: PubSocket;
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
  /** The shell message being handled, and since when. */
  #handling: { msgType: string; msgId: string; since: number } | null = null;
  // Open comms, for comm_info_request: comm_id -> target_name (#9).
  readonly #comms = new Map<string, string>();
  #shuttingDown = false;

  constructor(
    conn: ConnectionInfo,
    runtime: RuntimeName,
    options: {
      denoCompat?: boolean;
      /** Defaults to the process cwd, which Jupyter sets. */
      notebookDir?: string;
      /** What strips cells' types; esbuild by default (#238). */
      typeStrip?: TypeStripperName | TypeStripper;
    } = {},
  ) {
    this.#conn = conn;
    this.#runtime = runtime;
    this.#denoCompat = options.denoCompat ?? false;
    this.#typeStrip = options.typeStrip ?? "esbuild";
    this.#project = runtime === "deno" ? this.#loadProject(options.notebookDir ?? process.cwd()) : null;
    this.#debugger = runtime === "node" || runtime === "deno"
      ? new Debugger((event) => this.#publish("debug_event", event), () => this.#transformOptions())
      : null;
    startHeartbeat(conn.hb_port, conn.ip);
    this.#shell = new RouterSocket(conn.shell_port, conn.ip);
    this.#control = new RouterSocket(conn.control_port, conn.ip);
    this.#stdin = new RouterSocket(conn.stdin_port, conn.ip);
    this.#iopub = new PubSocket(conn.iopub_port, conn.ip);
  }

  async run(): Promise<void> {
    // Start the runtime eagerly so the first cell doesn't pay for it.
    this.#ensureTarget().catch((err) => this.#log(`target failed to start: ${err}`));
    process.on("SIGINT", () => void this.#interrupt());
    // Exiting runs the exit hook that kills the runtime (src/children.ts);
    // these signals' default action would skip it (#218).
    for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) {
      process.on(signal, () => {
        this.#shuttingDown = true;
        process.exit(code);
      });
    }
    // A state dump on stderr, for a kernel that has stopped answering (#237).
    if (process.platform !== "win32") process.on("SIGUSR2", () => void this.#logState());
    // Transforms are synchronous, so the stripper loads before any cell.
    if (typeof this.#typeStrip === "string") await loadTypeStripper(this.#typeStrip);
    await Promise.all([this.#loop(this.#shell, (m, p) => this.#handleShell(m, p)),
      this.#loop(this.#control, (m, p) => this.#handleControl(m, p)),
      this.#loop(this.#stdin, (m) => this.#handleStdin(m))]);
  }

  #log(text: string): void {
    process.stderr.write(`[cdp-kernel] ${text}\n`);
  }

  async #logState(): Promise<void> {
    const handling = this.#handling;
    const target = this.#target;
    let targetState: unknown = target === null ? (this.#targetStarting === null ? null : "starting") : target.runtime;
    if (target?.diagnose) targetState = await target.diagnose().catch((err) => `diagnose failed: ${err}`);
    this.#log(`state: ${JSON.stringify({
      shell: handling && { msgType: handling.msgType, msgId: handling.msgId, ms: Date.now() - handling.since },
      queued: this.#shell.incoming.size,
      executing: this.#executing,
      interrupting: this.#interrupting,
      awaitingInput: this.#input !== null,
      target: targetState,
    })}`);
  }

  #loadProject(notebookDir: string): DenoProject | null {
    try {
      return loadDenoProject(notebookDir);
    } catch (err) {
      // A broken deno.json mustn't stop the kernel: run as in a plain
      // directory and say why in the first cell.
      const reason = err instanceof Error ? err.message : String(err);
      this.#projectWarning = `${reason}; running without the project config`;
      this.#log(this.#projectWarning);
      return null;
    }
  }

  #transformOptions(): CellTransformOptions {
    return { ...this.#project?.transform, typeStrip: this.#typeStrip };
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
  async #handleComm(msg: Message): Promise<void> {
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

  #launchTarget(): Promise<KernelTarget> {
    if (this.#runtime === "bun") return BunTarget.launch(this.#targetEvents());
    if (this.#runtime === "workerd") return WorkerdTarget.launch(this.#targetEvents());
    if (this.#runtime === "celld") return launchCelld(this.#targetEvents());
    return Target.launch(this.#runtime, this.#targetEvents(), {
      denoCompat: this.#denoCompat,
      denoConfig: this.#project?.configPath,
    });
  }

  #ensureTarget(): Promise<KernelTarget> {
    if (this.#target) return Promise.resolve(this.#target);
    this.#targetStarting ??= this.#launchTarget().then(async (target) => {
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

  #targetEvents(): TargetEvents {
    return {
      stream: (name, text) => this.#publish("stream", { name, text }),
      message: (msg) => void this.#onTargetMessage(msg).catch((err) => this.#log(`error handling target message: ${err}`)),
      exit: (code, note) => {
        this.#target = null;
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
        buffers: msg.buffers.map((b) => new Uint8Array(Buffer.from(b, "base64"))),
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
    if (!this.#target || !this.#executing) return;
    this.#interrupting = true;
    try {
      await this.#target.interrupt();
    } finally {
      this.#interrupting = false;
    }
  }

  // --- messaging --------------------------------------------------------------

  #encode(msgType: string, content: JsonObject, parentHeader: JsonObject, extra: { metadata?: JsonObject; buffers?: Uint8Array[] } = {}) {
    return encodeMessage(this.#session, this.#conn.key, msgType, content, { parentHeader, ...extra });
  }

  #publish(msgType: string, content: JsonObject, extra: { metadata?: JsonObject; buffers?: Uint8Array[]; parent?: JsonObject } = {}): void {
    this.#iopub.send(this.#encode(msgType, content, extra.parent ?? this.#parent, extra));
  }

  #status(state: "busy" | "idle", parent: JsonObject): void {
    this.#publish("status", { execution_state: state }, { parent });
  }

  #reply(socket: RouterSocket, peer: string, request: Message, msgType: string, content: JsonObject): void {
    socket.send(peer, this.#encode(msgType, content, request.header));
  }

  async #loop(socket: RouterSocket, handle: (msg: Message, peer: string) => Promise<void>): Promise<void> {
    while (!this.#shuttingDown) {
      const { peer, frames } = await socket.recv();
      if (socket === this.#shell) {
        this.#aborting = this.#abortQueued > 0;
        if (this.#aborting) this.#abortQueued--;
      }
      try {
        const msg = decodeMessage(frames);
        // Unsigned or forged messages are dropped, as in Deno.
        if (!verify(this.#conn.key, msg.signedParts, msg.sig)) continue;
        if (socket === this.#shell) this.#handling = { msgType: msg.header.msg_type, msgId: msg.header.msg_id, since: Date.now() };
        await handle(msg, peer);
      } catch (err) {
        this.#log(`error handling message: ${err instanceof Error ? err.stack : err}`);
      } finally {
        if (socket === this.#shell) this.#handling = null;
      }
    }
  }

  #kernelInfo(): JsonObject {
    const versions = this.#target?.versions;
    return {
      status: "ok",
      protocol_version: PROTOCOL_VERSION,
      implementation: "cdp-kernel",
      implementation_version: VERSION,
      language_info: {
        name: "typescript",
        version: "5",
        mimetype: "text/x.typescript",
        file_extension: ".ts",
        pygments_lexer: "typescript",
        codemirror_mode: "typescript",
        nbconvert_exporter: "script",
      },
      banner: `cdp-kernel on ${this.#runtime} ${versions?.runtime ?? ""} (${versions?.engine || "?"})`,
      help_links: [],
      debugger: this.#debugger !== null,
      // What current ipykernel advertises; JupyterLab itself goes by the
      // kernelspec's metadata.debugger.
      supported_features: this.#debugger !== null ? ["debugger"] : [],
    };
  }

  // --- control channel ------------------------------------------------------

  async #handleControl(msg: Message, peer: string): Promise<void> {
    // Every request is wrapped in busy/idle, as on shell (#124). JupyterLab
    // treats a debug request as done only once the kernel reports idle for
    // it. (Jupyter Server leaves debug_request out of the kernel's status.)
    this.#status("busy", msg.header);
    try {
      await this.#controlRequest(this.#control, msg, peer);
    } finally {
      this.#status("idle", msg.header);
    }
  }

  /** Control requests; shutdown and interrupt may also arrive on shell (#124). */
  async #controlRequest(socket: RouterSocket, msg: Message, peer: string): Promise<void> {
    switch (msg.header.msg_type) {
      case "kernel_info_request":
        this.#reply(socket, peer, msg, "kernel_info_reply", this.#kernelInfo());
        break;
      case "interrupt_request":
        // Answer even if the target doesn't (#121); the interrupt goes on.
        await Promise.race([
          this.#interrupt().catch((err) => this.#log(`interrupt failed: ${err}`)),
          new Promise((r) => setTimeout(r, INTERRUPT_REPLY_WAIT_MS)),
        ]);
        this.#reply(socket, peer, msg, "interrupt_reply", { status: "ok" });
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
        this.#reply(socket, peer, msg, "debug_reply", reply);
        break;
      }
      case "shutdown_request": {
        const restart = msg.content.restart === true;
        this.#reply(socket, peer, msg, "shutdown_reply", { status: "ok", restart });
        this.#shuttingDown = true;
        this.#target?.kill();
        // Frontends spawn a fresh kernel even on restart; exit after the
        // reply has had a moment to flush (denoland/deno#20556).
        setTimeout(() => process.exit(0), 100);
        break;
      }
    }
  }

  // --- shell channel ----------------------------------------------------------

  async #handleShell(msg: Message, peer: string): Promise<void> {
    const type = msg.header.msg_type;
    if (type === "execute_request") return this.#execute(msg, peer);
    this.#status("busy", msg.header);
    try {
      switch (type) {
        case "kernel_info_request":
          await this.#ensureTarget().catch(() => null);
          this.#reply(this.#shell, peer, msg, "kernel_info_reply", this.#kernelInfo());
          break;
        case "complete_request":
          this.#reply(this.#shell, peer, msg, "complete_reply", await this.#complete(msg));
          break;
        case "is_complete_request":
          this.#reply(this.#shell, peer, msg, "is_complete_reply", checkIsComplete(String(msg.content.code ?? "")));
          break;
        case "inspect_request":
          this.#reply(this.#shell, peer, msg, "inspect_reply", await this.#inspect(msg));
          break;
        case "history_request":
          this.#reply(this.#shell, peer, msg, "history_reply", { status: "ok", history: queryHistory(this.#history, msg.content) });
          break;
        case "comm_info_request":
          this.#reply(this.#shell, peer, msg, "comm_info_reply", { status: "ok", comms: this.#commInfo(msg.content) });
          break;
        case "comm_open":
        case "comm_msg":
        case "comm_close":
          await this.#handleComm(msg);
          break;
        case "shutdown_request":
        case "interrupt_request":
          // Deprecated on shell, but still allowed, and ipykernel takes them.
          await this.#controlRequest(this.#shell, msg, peer);
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
        this.#reply(this.#shell, peer, msg, replyType, { status: "error", ...error });
      }
      throw err;
    } finally {
      this.#status("idle", msg.header);
    }
  }

  /** The tooltip (Shift-Tab) for the name at the cursor (#10). */
  async #inspect(msg: Message): Promise<JsonObject> {
    const code = String(msg.content.code ?? "");
    const cursorCp = typeof msg.content.cursor_pos === "number"
      ? msg.content.cursor_pos
      : utf16ToCodePointIndex(code, code.length);
    const path = inspectTarget(code, codePointToUtf16Index(code, cursorCp));
    const detail = msg.content.detail_level === 1 ? 1 : 0;
    const text = path === null ? null : await (await this.#ensureTarget()).inspect(path, detail);
    return text === null
      ? { status: "ok", found: false, data: {}, metadata: {} }
      : { status: "ok", found: true, data: { "text/plain": text }, metadata: {} };
  }

  async #complete(msg: Message): Promise<JsonObject> {
    const code = String(msg.content.code ?? "");
    const cursorCp = typeof msg.content.cursor_pos === "number"
      ? msg.content.cursor_pos
      : utf16ToCodePointIndex(code, code.length);
    const cursor = codePointToUtf16Index(code, cursorCp);
    const expr = exprAtCursor(code, cursor);
    const target = await this.#ensureTarget();
    let matches: string[];
    let start: number;
    const dot = expr.lastIndexOf(".");
    if (dot !== -1) {
      const prefix = expr.slice(dot + 1);
      matches = (await target.propertyNames(expr.slice(0, dot)))
        .filter((name) => name.startsWith(prefix) && !name.startsWith("Symbol("));
      start = cursor - prefix.length;
    } else {
      const names = new Set([...(await target.propertyNames("globalThis")), ...(await target.lexicalNames())]);
      matches = [...names].filter((name) => name.startsWith(expr) && !name.startsWith("__cdpk")).sort();
      start = cursor - expr.length;
    }
    return {
      status: "ok",
      matches,
      cursor_start: utf16ToCodePointIndex(code, start),
      cursor_end: cursorCp,
      metadata: {},
    };
  }

  async #requestInput(prompt: string, password: boolean): Promise<InputAnswer> {
    // The target asked while an interrupt was already waiting on it.
    if (this.#interrupting) return { value: null, interrupted: true };
    const parent = this.#parent;
    if (!this.#allowStdin || typeof parent.msg_id !== "string") return NO_INPUT;
    if (this.#stdin.peers.size === 0) await new Promise((r) => setTimeout(r, 100));
    if (this.#stdin.peers.size === 0) return NO_INPUT;
    const header = makeHeader(this.#session, "input_request");
    const answer = new Promise<InputAnswer>((settle) => (this.#input = { msgId: header.msg_id, settle }));
    this.#stdin.sendAll(encodeMessage(this.#session, this.#conn.key, "input_request", { prompt, password }, {
      header,
      parentHeader: parent,
    }));
    return answer;
  }

  /** stdin carries only input_replys. */
  async #handleStdin(reply: Message): Promise<void> {
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

  async #evaluateCell(target: KernelTarget, code: string): Promise<EvaluateResult> {
    // Object-literal wrapping (Deno's evaluate_line_with_object_wrapping):
    // try `({ ... })` first and fall back to the code as written.
    // While debugging, cells carry the path JupyterLab gave them and keep a
    // line map, so breakpoints bind and frames point at the cell (#18).
    const debugging = this.#debugger?.started === true && target.debug !== undefined;
    const transform = (source: string) =>
      debugging && this.#debugger ? this.#debugger.cellScript(code, source) : target.transform(source, this.#transformOptions());
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

  async #execute(msg: Message, peer: string): Promise<void> {
    const parent = msg.header;
    if (this.#aborting) {
      // Queued behind a failed cell: not run, not counted (#123).
      this.#status("busy", parent);
      this.#reply(this.#shell, peer, msg, "execute_reply", { status: "aborted" });
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
    this.#executing = true;
    try {
      const target = await this.#ensureTarget();
      if (target.notice !== undefined && this.#noticeShownFor !== target) {
        // Once per target, in the first cell it runs.
        this.#noticeShownFor = target;
        this.#publish("stream", { name: "stderr", text: `${target.notice}\n` });
      }
      const result = await this.#evaluateCell(target, code);
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
      } else if (!silent && result.result.type !== "undefined") {
        await target.broadcastResult(count, result.result);
      }
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

    if (error) {
      if (!silent && msg.content.stop_on_error !== false) {
        // Abort what was queued behind this cell (JupyterLab's Run All sends
        // every cell at once), but nothing sent after the client sees the
        // error. A macrotask first lets bytes already received be parsed.
        await new Promise((r) => setTimeout(r, 0));
        this.#abortQueued = this.#shell.incoming.size;
      }
      this.#publish("error", error);
      this.#reply(this.#shell, peer, msg, "execute_reply", { status: "error", execution_count: count, ...error });
    } else {
      this.#reply(this.#shell, peer, msg, "execute_reply", {
        status: "ok",
        execution_count: count,
        payload: [],
        user_expressions: {},
      });
    }
    this.#status("idle", parent);
  }
}
