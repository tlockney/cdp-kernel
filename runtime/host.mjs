// @ts-self-types="./host.d.mts"
// jupyter.host() (#461): the client for a Ganymede server's host API, which
// lets a cell read, search and (when granted) run other notebooks. The
// server opens a comm to target `ganymede.host.v1` when the kernel starts,
// with its `hello` as the open's data. Calls go out as comm messages
// `{ id, method, params }`; the server replies `{ id, result }` or
// `{ id, error: { code, message } }` on a kernel subshell, so a cell that
// awaits a call gets its reply. The message format and error codes are
// ganymede-device's, so the two clients behave alike.
//
// Design: https://github.com/tlockney/ganymede/blob/main/docs/host-api.md

export const HOST_TARGET = "ganymede.host.v1";

const CODES = new Set(["unavailable", "denied", "cancelled", "timeout", "failed", "disconnected"]);

export class HostError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HostError";
    this.code = code;
  }

  /** An abort becomes `cancelled`, a timeout signal's abort `timeout`, anything else `failed`. */
  static from(err) {
    if (err instanceof HostError) return err;
    const message = typeof err?.message === "string" ? err.message : String(err);
    if (err?.name === "AbortError") return new HostError("cancelled", message);
    if (err?.name === "TimeoutError") return new HostError("timeout", message);
    if (typeof err?.code === "string" && CODES.has(err.code)) return new HostError(err.code, message);
    return new HostError("failed", message);
  }
}

/** Why an aborted signal ended a call: `timeout` for a timeout signal, else `cancelled`. */
function abortError(reason) {
  const message = typeof reason?.message === "string" ? reason.message : String(reason ?? "aborted");
  return new HostError(reason?.name === "TimeoutError" ? "timeout" : "cancelled", message);
}

/** A server's `hello`, or null when `data` isn't one. */
function helloOf(data) {
  if (data === null || typeof data !== "object" || typeof data.protocol !== "number") return null;
  return {
    protocol: data.protocol,
    server: typeof data.server === "string" ? data.server : "",
    notebook: typeof data.notebook === "string" ? data.notebook : null,
    methods: Array.isArray(data.methods) ? data.methods.filter((m) => typeof m === "string") : [],
  };
}

/**
 * @param {import("./comm.d.mts").CommApi} comms
 * @param {() => AbortSignal | undefined} [defaultSignal] the signal a call
 *   watches when it is given none: jupyter.signal.
 */
export function createHost(comms, defaultSignal = () => undefined) {
  /** The open host comm: { comm, hello, host, pending }, or null. */
  let link = null;
  /** Whoever waits for a hello: called with the link's Host, or null once there is no link. */
  const waiters = new Set();
  /**
   * A comm this runtime opened went unanswered: no server. Remembered, so
   * each `jupyter.host()` after the first answers null at once, until a
   * server opens the comm itself.
   */
  let noServer = false;
  let nextId = 0;

  function settle() {
    const host = link?.host ?? null;
    if (host === null && link !== null) return;
    for (const waiter of [...waiters]) waiter(host);
  }

  /** `ours`: this runtime opened the comm, not the server. */
  function adopt(comm, data, ours = false) {
    // A new comm replaces the old one: the server opens one per kernel start.
    const old = link;
    const l = { comm, host: null, pending: new Map(), ours };
    if (!ours) noServer = false;
    link = l;
    if (old !== null && !old.comm.closed) old.comm.close();
    const hello = helloOf(data);
    if (hello !== null) l.host = makeHost(l, hello);
    comm.onMsg(({ data }) => {
      if (data.hello !== undefined) {
        const hello = helloOf(data.hello);
        if (hello !== null) {
          l.host = makeHost(l, hello);
          if (link === l) settle();
        }
        return;
      }
      const call = l.pending.get(data.id);
      if (call === undefined) return;
      if (data.error !== undefined) {
        const { code, message } = data.error ?? {};
        call.reject(new HostError(CODES.has(code) ? code : "failed", typeof message === "string" ? message : String(code)));
      } else {
        call.resolve(data.result);
      }
    });
    comm.onClose(({ data }) => {
      for (const call of l.pending.values()) {
        call.reject(new HostError("disconnected", typeof data?.error === "string" ? `host comm closed: ${data.error}` : "host comm closed"));
      }
      l.pending.clear();
      if (link === l) {
        link = null;
        // The frontend closed the comm this runtime opened: no server.
        if (l.ours && l.host === null) noServer = true;
        settle();
      }
    });
    if (l.host !== null) settle();
  }

  function makeHost(l, hello) {
    const methods = Object.freeze([...hello.methods]);
    function call(method, params = {}, { signal = defaultSignal() } = {}) {
      if (signal?.aborted) return Promise.reject(abortError(signal.reason));
      if (l.comm.closed) return Promise.reject(new HostError("disconnected", "host comm closed"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          l.pending.delete(id);
          if (!l.comm.closed) l.comm.send({ id, cancel: true });
          reject(abortError(signal.reason));
        };
        const done = () => signal?.removeEventListener("abort", onAbort);
        const call = {
          resolve: (value) => (l.pending.delete(id), done(), resolve(value)),
          reject: (error) => (l.pending.delete(id), done(), reject(error)),
        };
        l.pending.set(id, call);
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          l.comm.send({ id, method, params });
        } catch (err) {
          // Params that can't be sent, such as a BigInt: the server never
          // got the call.
          call.reject(new HostError("failed", `cannot send ${method}: ${err instanceof Error ? err.message : err}`));
        }
      });
    }
    const bind = (method) => (params, options) => call(method, params, options);
    return Object.freeze({
      protocol: hello.protocol,
      server: hello.server,
      notebook: hello.notebook,
      methods,
      has: (method) => methods.includes(method),
      call,
      notebooks: Object.freeze({
        list: bind("notebooks.list"),
        read: bind("notebooks.read"),
        search: bind("notebooks.search"),
        results: bind("notebooks.results"),
        run: bind("notebooks.run"),
      }),
      self: Object.freeze({
        add: bind("self.add"),
        edit: bind("self.edit"),
        delete: bind("self.delete"),
      }),
    });
  }

  comms.registerTarget(HOST_TARGET, (comm, msg) => adopt(comm, msg.data));

  async function host({ timeout = 1000 } = {}) {
    if (link?.host) return link.host;
    // The wait for a server watches jupyter.signal, so an interrupt ends it.
    const signal = defaultSignal();
    if (signal?.aborted) throw abortError(signal.reason);
    if (noServer) return null;
    // No comm from the server (one whose comm closed, as when a runtime
    // restarts in the same kernel): open it from here. A Ganymede server
    // answers `{ hello }`; anything else closes it or stays silent.
    if (link === null) adopt(comms.open(HOST_TARGET), null, true);
    const mine = link;
    return new Promise((resolve, reject) => {
      let timer;
      const onAbort = () => {
        done();
        reject(abortError(signal.reason));
      };
      const done = () => {
        waiters.delete(waiter);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const waiter = (host) => {
        done();
        resolve(host);
      };
      waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      // Each caller waits its own timeout; the last to give up on a comm
      // this runtime opened closes it.
      timer = setTimeout(() => {
        done();
        if (waiters.size === 0 && link === mine && mine.host === null && mine.ours) {
          link = null;
          noServer = true;
          mine.comm.close();
        }
        resolve(null);
      }, timeout);
    });
  }

  return { host };
}
