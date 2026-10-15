/** A comm message as a handler receives it. */
export interface CommMessage {
  data: { [key: string]: unknown };
  metadata: { [key: string]: unknown };
  buffers: Uint8Array[];
}

export interface CommSendOptions {
  metadata?: { [key: string]: unknown };
  buffers?: Uint8Array[];
}

/** One end of a Jupyter comm channel. */
export interface Comm {
  readonly id: string;
  readonly targetName: string;
  readonly closed: boolean;
  send(data?: { [key: string]: unknown }, options?: CommSendOptions): void;
  close(data?: { [key: string]: unknown }, options?: CommSendOptions): void;
  onMsg(handler: (msg: CommMessage) => void | Promise<void>): void;
  onClose(handler: (msg: CommMessage) => void | Promise<void>): void;
}

/** `jupyter.comm`: open comms, and accept comms the frontend opens. */
export interface CommApi {
  open(targetName: string, data?: { [key: string]: unknown }, options?: CommSendOptions): Comm;
  registerTarget(targetName: string, handler: (comm: Comm, msg: CommMessage) => void | Promise<void>): void;
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
