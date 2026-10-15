// A minimal WebSocket client (RFC 6455) over a Unix socket, for the workerd
// target's session with its driver Worker (#26). The WebSocket that Node
// and Deno provide can't connect to a Unix socket, and a TCP listener would
// be reachable by every local process. Text messages only: that's all the
// session carries.

import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const OP_CONTINUATION = 0x0;
export const OP_TEXT = 0x1;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

export interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** One frame; clients must mask what they send. */
export function encodeFrame(opcode: number, payload: Buffer, mask: Buffer | null = randomBytes(4)): Buffer {
  const len = payload.length;
  const head = len < 126 ? 2 : len < 0x10000 ? 4 : 10;
  const out = Buffer.alloc(head + (mask ? 4 : 0) + len);
  out[0] = 0x80 | opcode;
  const maskBit = mask ? 0x80 : 0;
  if (len < 126) {
    out[1] = maskBit | len;
  } else if (len < 0x10000) {
    out[1] = maskBit | 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = maskBit | 127;
    out.writeBigUInt64BE(BigInt(len), 2);
  }
  if (mask) {
    mask.copy(out, head);
    for (let i = 0; i < len; i++) out[head + 4 + i] = payload[i] ^ mask[i & 3];
  } else {
    payload.copy(out, head);
  }
  return out;
}

/** Splits a byte stream into frames, holding back a partial one. */
export class FrameDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      const b = this.#buffer;
      if (b.length < 2) break;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (b.length < 4) break;
        len = b.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (b.length < 10) break;
        len = Number(b.readBigUInt64BE(2));
        offset = 10;
      }
      const maskAt = offset;
      if (masked) offset += 4;
      if (b.length < offset + len) break;
      const payload = Buffer.from(b.subarray(offset, offset + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= b[maskAt + (i & 3)];
      frames.push({ fin: (b[0] & 0x80) !== 0, opcode: b[0] & 0x0f, payload });
      this.#buffer = b.subarray(offset + len);
    }
    return frames;
  }
}

export function acceptKey(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

export interface WsChannel {
  send(text: string): void;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

/** Opens a WebSocket over the Unix socket at `socketPath`. */
export function connectUnixWebSocket(
  socketPath: string,
  { path = "/", headers = {} }: { path?: string; headers?: { [name: string]: string } } = {},
): Promise<WsChannel> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ path: socketPath });
    const key = randomBytes(16).toString("base64");
    const messageListeners: ((text: string) => void)[] = [];
    const closeListeners: (() => void)[] = [];
    let open = false;
    let closed = false;
    let head = Buffer.alloc(0);
    const decoder = new FrameDecoder();
    let parts: Buffer[] = [];

    const finish = () => {
      if (closed) return;
      closed = true;
      if (!open) reject(new Error("the WebSocket closed before it opened"));
      for (const listener of closeListeners) listener();
    };
    const write = (opcode: number, payload: Buffer) => {
      if (!closed) socket.write(encodeFrame(opcode, payload));
    };
    const channel: WsChannel = {
      send: (text) => write(OP_TEXT, Buffer.from(text)),
      onMessage: (listener) => void messageListeners.push(listener),
      onClose: (listener) => void closeListeners.push(listener),
      close() {
        write(OP_CLOSE, Buffer.alloc(0));
        socket.end();
      },
    };
    const onFrames = (frames: Frame[]) => {
      for (const frame of frames) {
        if (frame.opcode === OP_TEXT || frame.opcode === OP_CONTINUATION) {
          parts.push(frame.payload);
          if (frame.fin) {
            const text = Buffer.concat(parts).toString("utf8");
            parts = [];
            for (const listener of messageListeners) listener(text);
          }
        } else if (frame.opcode === OP_PING) {
          write(OP_PONG, frame.payload);
        } else if (frame.opcode === OP_CLOSE) {
          socket.end();
        }
      }
    };

    socket.on("data", (chunk: Buffer) => {
      if (open) return onFrames(decoder.push(chunk));
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      const response = head.subarray(0, end).toString("latin1");
      const accept = /^sec-websocket-accept:\s*(\S+)/im.exec(response)?.[1];
      if (!/^HTTP\/1\.1 101 /.test(response) || accept !== acceptKey(key)) {
        socket.destroy();
        reject(new Error(`the WebSocket handshake failed: ${response.split("\r\n")[0]}`));
        return;
      }
      open = true;
      resolve(channel);
      onFrames(decoder.push(head.subarray(end + 4)));
    });
    socket.on("error", (err) => {
      if (!open) reject(err);
    });
    socket.on("close", finish);
    const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("");
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: cdpk\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`,
    );
  });
}
