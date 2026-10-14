// Jupyter message handling: shell, control, stdin and iopub.
//
// Ported from startJupyterKernel in Deno's cli/js/jupyter_kernel.js
// (v2.9.6), which is Copyright 2018-2026 the Deno authors, MIT license.
// The thirteen op_jupyter_* calls into Deno's REPL isolate are replaced by
// a Target driven over CDP (src/target.ts).

import { Buffer } from "node:buffer";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { decodeMessage, encodeMessage, type JsonObject, type Message, PROTOCOL_VERSION, verify } from "./wire.ts";
import { PubSocket, RouterSocket, startHeartbeat } from "./zmtp.ts";
import { Interrupted, type RuntimeName, Target, type TargetEvents, type TargetMessage } from "./target.ts";
import { CellSyntaxError, objectLiteralCandidate, transformCell } from "./transform.ts";
import { checkIsComplete, codePointToUtf16Index, exprAtCursor, utf16ToCodePointIndex } from "./text.ts";
import type { EvaluateResult } from "./cdp.ts";

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

interface ErrorContent extends JsonObject {
  ename: string;
  evalue: string;
  traceback: string[];
}

export class Kernel {
  readonly #conn: ConnectionInfo;
  readonly #runtime: RuntimeName;
  readonly #denoCompat: boolean;
  readonly #session = randomUUID();
  readonly #shell: RouterSocket;
  readonly #control: RouterSocket;
  readonly #stdin: RouterSocket;
  readonly #iopub: PubSocket;
  #target: Target | null = null;
  #targetStarting: Promise<Target> | null = null;
  #executionCount = 0;
  #parent: JsonObject = {};
  #allowStdin = false;
  #executing = false;
  #shuttingDown = false;

  constructor(conn: ConnectionInfo, runtime: RuntimeName, options: { denoCompat?: boolean } = {}) {
    this.#conn = conn;
    this.#runtime = runtime;
    this.#denoCompat = options.denoCompat ?? false;
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
    await Promise.all([this.#loop(this.#shell, (m, p) => this.#handleShell(m, p)),
      this.#loop(this.#control, (m, p) => this.#handleControl(m, p))]);
  }

  #log(text: string): void {
    process.stderr.write(`[cdp-kernel] ${text}\n`);
  }

  // --- target lifecycle -----------------------------------------------------

  #ensureTarget(): Promise<Target> {
    if (this.#target) return Promise.resolve(this.#target);
    this.#targetStarting ??= Target.launch(this.#runtime, this.#targetEvents(), { denoCompat: this.#denoCompat }).then((target) => {
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
      message: (msg) => void this.#onTargetMessage(msg),
      exit: (code) => {
        this.#target = null;
        if (!this.#shuttingDown) {
          this.#publish("stream", { name: "stderr", text: `\n[cdp-kernel] ${this.#runtime} exited (${code}); restarting on next cell\n` });
        }
      },
    };
  }

  async #onTargetMessage(msg: TargetMessage): Promise<void> {
    if (msg.kind === "iopub") {
      this.#publish(msg.msg_type, msg.content, {
        metadata: msg.metadata,
        buffers: msg.buffers.map((b) => new Uint8Array(Buffer.from(b, "base64"))),
      });
      return;
    }
    let value: string | null = null;
    try {
      value = await this.#requestInput(msg.prompt, msg.password);
    } finally {
      // Always answer exactly once so the target's blocking read returns.
      this.#target?.replyInput(value);
    }
  }

  async #interrupt(): Promise<void> {
    if (this.#target && this.#executing) await this.#target.interrupt();
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
      try {
        const msg = decodeMessage(frames);
        // Unsigned or forged messages are dropped, as in Deno.
        if (!verify(this.#conn.key, msg.signedParts, msg.sig)) continue;
        await handle(msg, peer);
      } catch (err) {
        this.#log(`error handling message: ${err instanceof Error ? err.stack : err}`);
      }
    }
  }

  #kernelInfo(): JsonObject {
    const versions = this.#target?.versions;
    return {
      status: "ok",
      protocol_version: PROTOCOL_VERSION,
      implementation: "cdp-kernel",
      implementation_version: "0.1.0",
      language_info: {
        name: "typescript",
        version: "5",
        mimetype: "text/x.typescript",
        file_extension: ".ts",
        pygments_lexer: "typescript",
        codemirror_mode: "typescript",
        nbconvert_exporter: "script",
      },
      banner: `cdp-kernel on ${this.#runtime} ${versions?.runtime ?? ""} (V8 ${versions?.v8 ?? "?"})`,
      help_links: [],
      debugger: false,
    };
  }

  // --- control channel ------------------------------------------------------

  async #handleControl(msg: Message, peer: string): Promise<void> {
    switch (msg.header.msg_type) {
      case "kernel_info_request":
        this.#reply(this.#control, peer, msg, "kernel_info_reply", this.#kernelInfo());
        break;
      case "interrupt_request":
        await this.#interrupt();
        this.#reply(this.#control, peer, msg, "interrupt_reply", { status: "ok" });
        break;
      case "shutdown_request": {
        const restart = msg.content.restart === true;
        this.#reply(this.#control, peer, msg, "shutdown_reply", { status: "ok", restart });
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
          this.#reply(this.#shell, peer, msg, "inspect_reply", { status: "ok", found: false, data: {}, metadata: {} });
          break;
        case "history_request":
          this.#reply(this.#shell, peer, msg, "history_reply", { status: "ok", history: [] });
          break;
        case "comm_info_request":
          this.#reply(this.#shell, peer, msg, "comm_info_reply", { status: "ok", comms: {} });
          break;
        case "comm_open":
          // No comm targets (widgets) yet: close it straight away, like Deno.
          this.#publish("comm_close", { comm_id: msg.content.comm_id ?? "", data: {} }, { parent: msg.header });
          break;
      }
    } finally {
      this.#status("idle", msg.header);
    }
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

  async #requestInput(prompt: string, password: boolean): Promise<string | null> {
    const parent = this.#parent;
    if (!this.#allowStdin || typeof parent.msg_id !== "string") return null;
    if (this.#stdin.peers.size === 0) await new Promise((r) => setTimeout(r, 100));
    if (this.#stdin.peers.size === 0) return null;
    this.#stdin.sendAll(this.#encode("input_request", { prompt, password }, parent));
    for (;;) {
      const { frames } = await this.#stdin.recv();
      const reply = decodeMessage(frames);
      if (!verify(this.#conn.key, reply.signedParts, reply.sig)) continue;
      if (reply.header.msg_type === "input_reply") {
        return typeof reply.content.value === "string" ? reply.content.value : null;
      }
    }
  }

  async #evaluateCell(target: Target, code: string): Promise<EvaluateResult> {
    // Object-literal wrapping (Deno's evaluate_line_with_object_wrapping):
    // try `({ ... })` first and fall back to the code as written.
    const wrapped = objectLiteralCandidate(code);
    if (wrapped !== null) {
      try {
        const result = await target.evaluate(transformCell(wrapped));
        if (!result.exceptionDetails) return result;
      } catch (err) {
        if (!(err instanceof CellSyntaxError)) throw err;
      }
    }
    return target.evaluate(transformCell(code));
  }

  async #execute(msg: Message, peer: string): Promise<void> {
    const parent = msg.header;
    const code = String(msg.content.code ?? "");
    const silent = msg.content.silent === true;
    if (!silent && msg.content.store_history !== false) this.#executionCount++;
    const count = this.#executionCount;
    this.#parent = parent;
    this.#allowStdin = msg.content.allow_stdin === true;
    this.#status("busy", parent);
    this.#publish("execute_input", { code, execution_count: count });

    let error: ErrorContent | null = null;
    this.#executing = true;
    try {
      const target = await this.#ensureTarget();
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
