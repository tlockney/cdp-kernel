// Jupyter message shapes and headers, without the wire format: what the
// kernel's message handling (src/kernel-core.ts) builds and reads. The
// framing and HMAC signing that ZeroMQ peers need are in src/wire.ts.

export const PROTOCOL_VERSION = "5.3";

export type JsonObject = { [key: string]: unknown };

export interface Header extends JsonObject {
  msg_id: string;
  session: string;
  date: string;
  username: string;
  msg_type: string;
  version: string;
}

/** A header as received: the fields the kernel relies on, plus whatever else came. */
export interface ReceivedHeader extends JsonObject {
  msg_id: string;
  msg_type: string;
}

/** A message from a frontend, decoded (and on ZeroMQ, verified). */
export interface KernelMessage {
  header: ReceivedHeader;
  parentHeader: JsonObject;
  metadata: JsonObject;
  content: JsonObject;
  buffers: Uint8Array[];
}

/** A message the kernel sends. */
export interface OutgoingMessage {
  header: Header;
  parentHeader: JsonObject;
  metadata: JsonObject;
  content: JsonObject;
  buffers: Uint8Array[];
}

export function makeHeader(session: string, msgType: string): Header {
  return {
    msg_id: crypto.randomUUID(),
    session,
    date: new Date().toISOString(),
    username: "kernel",
    msg_type: msgType,
    version: PROTOCOL_VERSION,
  };
}
