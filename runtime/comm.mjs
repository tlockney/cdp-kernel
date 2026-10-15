// @ts-self-types="./comm.d.mts"
// Jupyter comms: bidirectional channels between kernel and frontend, the
// transport ipywidgets and anywidget are built on (#9). Runs inside the
// target runtime.
//
// Kernel-to-frontend messages (comm_open, comm_msg, comm_close) go out
// through `send`, the same ordered path as display messages. Frontend
// messages arrive from the host through `dispatch`, which returns whether
// anything in the kernel handled them, so the host can answer an unknown
// target's comm_open with a comm_close, as the protocol asks.

class Comm {
  #send;
  #onClosed;
  #msgHandlers = [];
  #closeHandlers = [];
  closed = false;

  constructor(id, targetName, send, onClosed) {
    this.id = id;
    this.targetName = targetName;
    this.#send = send;
    this.#onClosed = onClosed;
  }

  send(data = {}, { metadata = {}, buffers = [] } = {}) {
    if (this.closed) return;
    this.#send("comm_msg", { comm_id: this.id, data }, metadata, buffers);
  }

  close(data = {}, { metadata = {}, buffers = [] } = {}) {
    if (this.closed) return;
    this.#send("comm_close", { comm_id: this.id, data }, metadata, buffers);
    // close() is synchronous for callers; its close handlers run detached.
    void this._closed({ data, metadata, buffers });
  }

  onMsg(handler) {
    this.#msgHandlers.push(handler);
  }

  onClose(handler) {
    this.#closeHandlers.push(handler);
  }

  async _receive(msg) {
    for (const handler of this.#msgHandlers) await handler(msg);
  }

  async _closed(msg) {
    if (this.closed) return;
    this.closed = true;
    this.#onClosed(this.id);
    for (const handler of this.#closeHandlers) await handler(msg);
  }
}

/**
 * @param {(msgType: string, content: object, metadata: object, buffers: Uint8Array[]) => void} send
 * @param {() => string} [newId]
 */
export function createComms(send, newId = () => crypto.randomUUID()) {
  const comms = new Map(); // comm_id -> Comm
  const targets = new Map(); // target_name -> handler
  const forget = (id) => comms.delete(id);

  function track(id, targetName) {
    const comm = new Comm(id, targetName, send, forget);
    comms.set(id, comm);
    return comm;
  }

  const api = {
    open(targetName, data = {}, { metadata = {}, buffers = [] } = {}) {
      const comm = track(newId(), targetName);
      send("comm_open", { comm_id: comm.id, target_name: targetName, data }, metadata, buffers);
      return comm;
    },
    registerTarget(targetName, handler) {
      targets.set(targetName, handler);
    },
    unregisterTarget(targetName) {
      targets.delete(targetName);
    },
  };

  async function dispatch(msgType, content, metadata, buffers) {
    const msg = { data: content.data ?? {}, metadata: metadata ?? {}, buffers: buffers ?? [] };
    if (msgType === "comm_open") {
      const handler = targets.get(content.target_name);
      if (!handler) return false;
      await handler(track(content.comm_id, content.target_name), msg);
      return true;
    }
    const comm = comms.get(content.comm_id);
    if (!comm) return false;
    if (msgType === "comm_msg") await comm._receive(msg);
    else if (msgType === "comm_close") await comm._closed(msg);
    else return false;
    return true;
  }

  function list() {
    return [...comms.values()].map((comm) => ({ commId: comm.id, targetName: comm.targetName }));
  }

  return { api, dispatch, list };
}
