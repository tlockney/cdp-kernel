// A small Chrome DevTools Protocol client over the runtime's --inspect
// WebSocket. Uses the global WebSocket (Node 22+, Deno, Bun).

export type CdpParams = { [key: string]: unknown };

export interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}

export interface ExceptionDetails {
  text: string;
  lineNumber: number;
  columnNumber: number;
  exception?: RemoteObject;
}

export interface EvaluateResult {
  result: RemoteObject;
  exceptionDetails?: ExceptionDetails;
}

interface CdpResponse {
  id: number;
  result?: CdpParams;
  error?: { code: number; message: string };
}

interface CdpEvent {
  method: string;
  params: CdpParams;
}

export class CdpError extends Error {
  readonly code: number;
  constructor(method: string, code: number, message: string) {
    super(`${method}: ${message} (${code})`);
    this.code = code;
  }
}

/** Thrown into a pending call when the caller abandons it (interrupt). */
export class CdpAbandoned extends Error {}

type Pending = {
  method: string;
  resolve: (result: CdpParams) => void;
  reject: (err: Error) => void;
};

function isResponse(msg: unknown): msg is CdpResponse {
  return typeof msg === "object" && msg !== null && typeof (msg as CdpResponse).id === "number";
}

function isEvent(msg: unknown): msg is CdpEvent {
  return typeof msg === "object" && msg !== null && typeof (msg as CdpEvent).method === "string";
}

export class CdpSession {
  #ws: WebSocket;
  #nextId = 0;
  #pending = new Map<number, Pending>();
  #listeners = new Map<string, ((params: CdpParams) => void)[]>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      const msg: unknown = JSON.parse(String(event.data));
      if (isResponse(msg)) {
        const pending = this.#pending.get(msg.id);
        if (!pending) return;
        this.#pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new CdpError(pending.method, msg.error.code, msg.error.message));
        } else {
          pending.resolve(msg.result ?? {});
        }
      } else if (isEvent(msg)) {
        for (const listener of this.#listeners.get(msg.method) ?? []) listener(msg.params);
      }
    });
    ws.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("CDP connection closed"));
      }
      this.#pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpSession> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new CdpSession(ws);
  }

  on(method: string, listener: (params: CdpParams) => void): void {
    const list = this.#listeners.get(method) ?? [];
    list.push(listener);
    this.#listeners.set(method, list);
  }

  send(method: string, params: CdpParams = {}): Promise<CdpParams> {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Reject every in-flight call; their late responses are then ignored. */
  abandonPending(): void {
    for (const pending of this.#pending.values()) {
      pending.reject(new CdpAbandoned(`${pending.method} abandoned`));
    }
    this.#pending.clear();
  }

  close(): void {
    this.#ws.close();
  }
}

export function asEvaluateResult(raw: CdpParams): EvaluateResult {
  return raw as unknown as EvaluateResult;
}
