// KernelChannels over ZeroMQ: the connection file's five ports, with
// messages framed and signed as src/wire.ts does it.

import type { ConnectionInfo } from "./kernel.ts";
import type { ChannelName, KernelChannels, Received } from "./kernel-core.ts";
import type { OutgoingMessage } from "./message.ts";
import { decodeMessage, encodeMessage, verify } from "./wire.ts";
import { listening, PubSocket, RouterSocket, startHeartbeat } from "./zmtp.ts";

export class ZmqChannels implements KernelChannels {
  readonly ready: Promise<unknown>;
  readonly #key: string;
  readonly #log: (text: string) => void;
  readonly #routers: Record<ChannelName, RouterSocket>;
  readonly #iopub: PubSocket;

  constructor(conn: ConnectionInfo, log: (text: string) => void) {
    this.#key = conn.key;
    this.#log = log;
    const heartbeat = startHeartbeat(conn.hb_port, conn.ip);
    this.#routers = {
      shell: new RouterSocket(conn.shell_port, conn.ip),
      control: new RouterSocket(conn.control_port, conn.ip),
      stdin: new RouterSocket(conn.stdin_port, conn.ip),
    };
    this.#iopub = new PubSocket(conn.iopub_port, conn.ip);
    // Settles once all five ports are bound (#257).
    this.ready = Promise.all(
      [heartbeat, ...Object.values(this.#routers).map((r) => r.server), this.#iopub.server].map(listening),
    );
  }

  async recv(channel: ChannelName): Promise<Received | null> {
    const { peer, frames } = await this.#routers[channel].recv();
    try {
      const msg = decodeMessage(frames);
      // Unsigned or forged messages are dropped, as in Deno.
      return verify(this.#key, msg.signedParts, msg.sig) ? { peer, msg } : null;
    } catch (err) {
      this.#log(`error handling message: ${err instanceof Error ? err.stack : err}`);
      return null;
    }
  }

  shellQueued(): number {
    return this.#routers.shell.incoming.size;
  }

  #encode(msg: OutgoingMessage): Uint8Array[] {
    return encodeMessage(msg.header.session, this.#key, msg.header.msg_type, msg.content, {
      header: msg.header,
      parentHeader: msg.parentHeader,
      metadata: msg.metadata,
      buffers: msg.buffers,
    });
  }

  reply(channel: ChannelName, peer: string, msg: OutgoingMessage): void {
    this.#routers[channel].send(peer, this.#encode(msg));
  }

  publish(msg: OutgoingMessage): void {
    this.#iopub.send(this.#encode(msg));
  }

  stdinPeers(): number {
    return this.#routers.stdin.peers.size;
  }

  sendStdin(msg: OutgoingMessage): void {
    this.#routers.stdin.sendAll(this.#encode(msg));
  }
}
