// Jupyter wire protocol: message framing and HMAC signing.
//
// Ported from Deno's cli/js/jupyter_kernel.js (v2.9.6), which is
// Copyright 2018-2026 the Deno authors, MIT license. The structure is kept;
// WebCrypto's async HMAC is replaced with node:crypto's synchronous one.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

export const DELIMITER = ENC.encode("<IDS|MSG>");
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

export interface Message {
  identities: Uint8Array[];
  sig: string;
  /** Raw bytes of header, parent_header, metadata, content as received. */
  signedParts: Uint8Array[];
  header: Header;
  parentHeader: JsonObject;
  metadata: JsonObject;
  content: JsonObject;
  buffers: Uint8Array[];
}

export function sign(key: string, parts: Uint8Array[]): string {
  if (key.length === 0) return "";
  const hmac = createHmac("sha256", key);
  for (const part of parts) hmac.update(part);
  return hmac.digest("hex");
}

// Messages that fail this check must be dropped: the kernel runs user code,
// so an unsigned execute_request from any local process would be code
// execution. Matches Deno's hmacVerify.
export function verify(key: string, parts: Uint8Array[], sig: string): boolean {
  if (key.length === 0) return true;
  if (!/^[0-9a-f]+$/i.test(sig) || sig.length % 2 !== 0) return false;
  const expected = Buffer.from(sign(key, parts), "hex");
  const actual = Buffer.from(sig, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function makeHeader(session: string, msgType: string): Header {
  return {
    msg_id: randomUUID(),
    session,
    date: new Date().toISOString(),
    username: "kernel",
    msg_type: msgType,
    version: PROTOCOL_VERSION,
  };
}

export interface EncodeOptions {
  identities?: Uint8Array[];
  parentHeader?: JsonObject;
  metadata?: JsonObject;
  buffers?: Uint8Array[];
}

export function encodeMessage(
  session: string,
  key: string,
  msgType: string,
  content: JsonObject,
  options: EncodeOptions = {},
): Uint8Array[] {
  const parts = [
    makeHeader(session, msgType),
    options.parentHeader ?? {},
    options.metadata ?? {},
    content,
  ].map((part) => ENC.encode(JSON.stringify(part)));
  return [
    ...(options.identities ?? []),
    DELIMITER,
    ENC.encode(sign(key, parts)),
    ...parts,
    ...(options.buffers ?? []),
  ];
}

function isDelimiter(frame: Uint8Array): boolean {
  if (frame.length !== DELIMITER.length) return false;
  for (let i = 0; i < frame.length; i++) {
    if (frame[i] !== DELIMITER[i]) return false;
  }
  return true;
}

function parseObject(frame: Uint8Array): JsonObject {
  const value: unknown = JSON.parse(DEC.decode(frame));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a JSON object frame");
  }
  return value as JsonObject;
}

function isHeader(value: JsonObject): value is Header {
  return typeof value.msg_id === "string" && typeof value.msg_type === "string";
}

export function decodeMessage(frames: Uint8Array[]): Message {
  const delimIdx = frames.findIndex(isDelimiter);
  if (delimIdx === -1 || frames.length < delimIdx + 6) {
    throw new Error("malformed message: no <IDS|MSG> delimiter");
  }
  const header = parseObject(frames[delimIdx + 2]);
  if (!isHeader(header)) throw new Error("malformed message header");
  return {
    identities: frames.slice(0, delimIdx),
    sig: DEC.decode(frames[delimIdx + 1]),
    signedParts: frames.slice(delimIdx + 2, delimIdx + 6),
    header,
    parentHeader: parseObject(frames[delimIdx + 3]),
    metadata: parseObject(frames[delimIdx + 4]),
    content: parseObject(frames[delimIdx + 5]),
    buffers: frames.slice(delimIdx + 6),
  };
}
