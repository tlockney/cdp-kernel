// Minimal ZMTP 3.0 server sockets (NULL mechanism) over node:net.
//
// Ported from Deno's cli/js/jupyter_kernel.js (v2.9.6), which is
// Copyright 2018-2026 the Deno authors, MIT license. Deno's kernel dropped
// libzmq in denoland/deno#34083 and speaks just enough ZMTP for Jupyter
// frontends; this keeps the same greeting, READY command and framing, and
// swaps Deno.listen for node:net plus a small buffered reader.

import { Buffer } from "node:buffer";
import { createServer, type Server, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { portHolders } from "./port-holder.ts";

const ENC = new TextEncoder();

/** Pull-style reader over a socket's 'data' events. */
export class SocketReader {
  #chunks: Buffer[] = [];
  #buffered = 0;
  #waiter: (() => void) | null = null;
  #closed = false;
  #error: Error | null = null;

  constructor(socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.#chunks.push(chunk);
      this.#buffered += chunk.length;
      this.#wake();
    });
    socket.on("close", () => {
      this.#closed = true;
      this.#wake();
    });
    socket.on("error", (err: Error) => {
      this.#error = err;
      this.#wake();
    });
  }

  #wake(): void {
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.();
  }

  // Each call joins every buffered chunk, so a reader that keeps a large
  // backlog while small chunks trickle in recopies it per call (quadratic).
  // Jupyter traffic over loopback arrives in few, large chunks; a chunk
  // list with an offset would avoid the copies if that ever changes.
  async readExact(n: number): Promise<Uint8Array> {
    while (this.#buffered < n) {
      if (this.#error) throw this.#error;
      if (this.#closed) throw new Error("connection closed");
      await new Promise<void>((resolve) => (this.#waiter = resolve));
    }
    const all = this.#chunks.length === 1 ? this.#chunks[0] : Buffer.concat(this.#chunks);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.#chunks = rest.length > 0 ? [rest] : [];
    this.#buffered = rest.length;
    return new Uint8Array(out);
  }
}

export interface Frame {
  data: Uint8Array;
  hasMore: boolean;
  isCommand: boolean;
}

export async function readFrame(reader: SocketReader): Promise<Frame> {
  const [flag] = await reader.readExact(1);
  const isLong = (flag & 0x02) !== 0;
  let size: number;
  if (isLong) {
    const b = await reader.readExact(8);
    size = Number(new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0));
  } else {
    [size] = await reader.readExact(1);
  }
  return {
    data: await reader.readExact(size),
    hasMore: (flag & 0x01) !== 0,
    isCommand: (flag & 0x04) !== 0,
  };
}

export function encodeFrame(data: Uint8Array, more: boolean, isCommand = false): Uint8Array {
  const long = data.length > 255;
  const flag = (more ? 0x01 : 0) | (long ? 0x02 : 0) | (isCommand ? 0x04 : 0);
  const headerLen = long ? 9 : 2;
  const buf = new Uint8Array(headerLen + data.length);
  buf[0] = flag;
  if (long) {
    new DataView(buf.buffer).setBigUint64(1, BigInt(data.length));
  } else {
    buf[1] = data.length;
  }
  buf.set(data, headerLen);
  return buf;
}

// One write per multipart message. Deno found that many small writes
// interact badly with Nagle/delayed-ACK against libzmq peers.
export function encodeMultipart(frames: Uint8Array[]): Buffer {
  return Buffer.concat(frames.map((f, i) => encodeFrame(f, i < frames.length - 1)));
}

export function makeGreeting(): Uint8Array {
  // Signature 0xff..0x7f, version 3.0, mechanism "NULL", as-server = 0.
  // Deno learned (regression from #34083) that libzmq peers stall if a
  // binding NULL peer sets as-server=1, so mirror libzmq's own greeting.
  const buf = new Uint8Array(64);
  buf[0] = 0xff;
  buf[9] = 0x7f;
  buf[10] = 3;
  buf[11] = 0;
  buf.set(ENC.encode("NULL"), 12);
  buf[32] = 0;
  return buf;
}

export function makeReadyCommand(socketType: string): Uint8Array {
  const name = ENC.encode("READY");
  const propName = ENC.encode("Socket-Type");
  const value = ENC.encode(socketType);
  const body = new Uint8Array(1 + name.length + 1 + propName.length + 4 + value.length);
  let o = 0;
  body[o++] = name.length;
  body.set(name, o);
  o += name.length;
  body[o++] = propName.length;
  body.set(propName, o);
  o += propName.length;
  new DataView(body.buffer).setUint32(o, value.length);
  o += 4;
  body.set(value, o);
  return encodeFrame(body, false, true);
}

async function handshake(socket: Socket, reader: SocketReader, socketType: string): Promise<void> {
  socket.write(makeGreeting());
  await reader.readExact(64);
  socket.write(makeReadyCommand(socketType));
  await readFrame(reader); // peer READY
}

export async function recvMultipart(reader: SocketReader): Promise<Uint8Array[]> {
  const frames: Uint8Array[] = [];
  for (;;) {
    const frame = await readFrame(reader);
    if (frame.isCommand) continue; // e.g. SUBSCRIBE/PING commands
    frames.push(frame.data);
    if (!frame.hasMore) return frames;
  }
}

/** How long a port from the connection file may stay taken before the kernel gives up. */
const LISTEN_RETRY_MS = 5000;
const LISTEN_RETRY_INTERVAL_MS = 100;

function listen(port: number, host: string, onConn: (socket: Socket) => void): Server {
  const server = createServer((socket) => {
    socket.setNoDelay(true);
    onConn(socket);
  });
  // The frontend picks these ports by binding and releasing them, so another
  // socket can take one before the kernel binds it. Wait for it to be freed
  // rather than die before kernel_info.
  const deadline = Date.now() + LISTEN_RETRY_MS;
  const onError = (err: Error & { code?: string }) => {
    if (err.code !== "EADDRINUSE" || Date.now() >= deadline) {
      // Who kept it, for a port that never came free (#257).
      if (err.code === "EADDRINUSE") {
        const holders = portHolders(port).map((line) => `  ${line}\n`).join("") || "  unknown\n";
        process.stderr.write(
          `[cdp-kernel] port ${port} still in use after ${LISTEN_RETRY_MS} ms; this kernel is pid ${process.pid} ` +
            `(ppid ${process.ppid}, ${process.execPath} ${process.version}); the port's sockets:\n${holders}`,
        );
      }
      server.off("error", onError);
      server.emit("error", err);
      return;
    }
    setTimeout(() => server.listen(port, host), LISTEN_RETRY_INTERVAL_MS);
  };
  server.on("error", onError);
  server.once("listening", () => server.off("error", onError));
  server.listen(port, host);
  return server;
}

/** Async FIFO with blocking pop. */
export class Queue<T> {
  #items: T[] = [];
  #waiters: ((item: T) => void)[] = [];
  /** Items waiting to be popped. */
  get size(): number {
    return this.#items.length;
  }
  push(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(item);
    else this.#items.push(item);
  }
  pop(): Promise<T> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

/** REP socket for the heartbeat channel: echo everything. */
export function startHeartbeat(port: number, host: string): Server {
  return listen(port, host, (socket) => {
    const reader = new SocketReader(socket);
    (async () => {
      await handshake(socket, reader, "REP");
      for (;;) socket.write(encodeMultipart(await recvMultipart(reader)));
    })().catch(() => socket.destroy());
  });
}

export interface RoutedMessage {
  peer: string;
  frames: Uint8Array[];
}

/**
 * ROUTER socket: each TCP connection is one peer with a generated identity.
 * Writes ignore socket.write's backpressure signal: node:net buffers the
 * rest, which is fine for loopback peers that read promptly.
 */
export class RouterSocket {
  readonly incoming = new Queue<RoutedMessage>();
  readonly peers = new Map<string, Socket>();
  readonly server: Server;

  constructor(port: number, host: string) {
    this.server = listen(port, host, (socket) => this.#handlePeer(socket));
  }

  #handlePeer(socket: Socket): void {
    const peer = randomBytes(5).toString("hex");
    const reader = new SocketReader(socket);
    (async () => {
      // Register only after the handshake so a proactive send (stdin's
      // input_request) can't land inside the greeting exchange.
      await handshake(socket, reader, "ROUTER");
      this.peers.set(peer, socket);
      for (;;) this.incoming.push({ peer, frames: await recvMultipart(reader) });
    })()
      .catch(() => {})
      .finally(() => {
        this.peers.delete(peer);
        socket.destroy();
      });
  }

  recv(): Promise<RoutedMessage> {
    return this.incoming.pop();
  }

  send(peer: string, frames: Uint8Array[]): void {
    this.peers.get(peer)?.write(encodeMultipart(frames));
  }

  sendAll(frames: Uint8Array[]): void {
    const buf = encodeMultipart(frames);
    for (const socket of this.peers.values()) socket.write(buf);
  }
}

/** PUB socket for iopub: fan out to every subscriber, no topic filtering. */
export class PubSocket {
  readonly subscribers = new Set<Socket>();
  readonly server: Server;

  constructor(port: number, host: string) {
    this.server = listen(port, host, (socket) => {
      const reader = new SocketReader(socket);
      (async () => {
        await handshake(socket, reader, "PUB");
        // SUB sends a SUBSCRIBE (a command frame in ZMTP 3.1, a 0x01-prefixed
        // message in 3.0). Readiness doesn't depend on it, so register now and
        // drain whatever arrives.
        this.subscribers.add(socket);
        for (;;) await readFrame(reader);
      })()
        .catch(() => {})
        .finally(() => {
          this.subscribers.delete(socket);
          socket.destroy();
        });
    });
  }

  send(frames: Uint8Array[]): void {
    const buf = encodeMultipart(frames);
    for (const socket of this.subscribers) socket.write(buf);
  }
}
