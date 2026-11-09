/** A comm message as a handler receives it. */
export interface CommMessage {
  /** The message's JSON data. */
  data: { [key: string]: unknown };
  /** The message's metadata. */
  metadata: { [key: string]: unknown };
  /** Binary buffers sent with the message. */
  buffers: Uint8Array[];
}

/** Options for sending, opening or closing a comm. */
export interface CommSendOptions {
  /** Metadata for the message. Default `{}`. */
  metadata?: { [key: string]: unknown };
  /** Binary buffers sent with the message. Default `[]`. */
  buffers?: Uint8Array[];
}

/** One end of a Jupyter comm channel, from `jupyter.comm.open` or a target handler. */
export interface Comm {
  /** The comm id, shared with the frontend's end. */
  readonly id: string;
  /** The target the comm was opened on. */
  readonly targetName: string;
  /** Whether either end has closed the comm. */
  readonly closed: boolean;
  /**
   * Send a message to the frontend's end. Does nothing once closed.
   *
   * @param data The message's JSON data. Default `{}`.
   * @param options Metadata and binary buffers.
   * @example
   * ```ts
   * const comm = jupyter.comm.open("my.target");
   * comm.send({ ping: true }, { buffers: [new Uint8Array([1, 2, 3])] });
   * ```
   */
  send(data?: { [key: string]: unknown }, options?: CommSendOptions): void;
  /**
   * Close the comm and tell the frontend. Its `onClose` handlers run
   * afterwards, without being awaited. Does nothing once closed.
   *
   * @param data Data sent with the close message. Default `{}`.
   * @param options Metadata and binary buffers.
   * @example
   * ```ts
   * const comm = jupyter.comm.open("my.target");
   * comm.close({ reason: "done" });
   * ```
   */
  close(data?: { [key: string]: unknown }, options?: CommSendOptions): void;
  /**
   * Handle messages from the frontend's end. A handler runs like a cell:
   * its output goes to the notebook, and an exception shows on stderr.
   *
   * @param handler Called with each message; may be async.
   * @example
   * ```ts
   * const comm = jupyter.comm.open("my.target");
   * comm.onMsg(({ data, buffers }) => console.log(data, buffers.length));
   * ```
   */
  onMsg(handler: (msg: CommMessage) => void | Promise<void>): void;
  /**
   * Handle the comm closing, from either end.
   *
   * @param handler Called with the close message; may be async.
   * @example
   * ```ts
   * const comm = jupyter.comm.open("my.target");
   * comm.onClose(() => console.log("closed"));
   * ```
   */
  onClose(handler: (msg: CommMessage) => void | Promise<void>): void;
}

/** `jupyter.comm`: open comms, and accept comms the frontend opens. */
export interface CommApi {
  /**
   * Open a comm to a target the frontend registered.
   *
   * @param targetName The frontend's target name.
   * @param data Data sent with the open message. Default `{}`.
   * @param options Metadata and binary buffers.
   * @returns The kernel's end of the comm.
   * @example
   * ```ts
   * const comm = jupyter.comm.open("my.target", { hello: 1 });
   * comm.onMsg((m) => console.log(m.data));
   * ```
   */
  open(targetName: string, data?: { [key: string]: unknown }, options?: CommSendOptions): Comm;
  /**
   * Accept comms the frontend opens on `targetName`. Registering the same
   * name again replaces the handler.
   *
   * @param targetName The target name the frontend opens comms on.
   * @param handler Called with the new comm and its open message.
   * @example
   * ```ts
   * jupyter.comm.registerTarget("echo", (comm) => comm.onMsg((m) => comm.send(m.data)));
   * ```
   */
  registerTarget(targetName: string, handler: (comm: Comm, msg: CommMessage) => void | Promise<void>): void;
  /**
   * Stop accepting new comms on `targetName`. Comms already open stay open.
   *
   * @param targetName The target to remove.
   * @example
   * ```ts
   * jupyter.comm.unregisterTarget("echo");
   * ```
   */
  unregisterTarget(targetName: string): void;
}

export interface Comms {
  api: CommApi;
  /** Routes a frontend comm message; resolves to whether a comm or target took it. */
  dispatch(
    msgType: string,
    content: { [key: string]: unknown },
    metadata: { [key: string]: unknown },
    buffers: Uint8Array[],
  ): Promise<boolean>;
  list(): { commId: string; targetName: string }[];
}

export function createComms(
  send: (msgType: string, content: object, metadata: object, buffers: Uint8Array[]) => void,
  newId?: () => string,
): Comms;
