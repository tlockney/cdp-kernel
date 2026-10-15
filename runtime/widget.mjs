// @ts-self-types="./widget.d.mts"
// anywidget-compatible widgets over Jupyter comms (#9): the kernel half of
// the ipywidgets model protocol (version 2.1.0) for anywidget's AnyModel,
// whose frontend is the `anywidget` JupyterLab/Notebook/VS Code extension.
//
//   const counter = jupyter.widget({ esm, state: { count: 0 } });
//   counter            // display it
//   counter.get("count"); counter.set("count", 1);
//   counter.on("change:count", (value, old) => ...);
//
// State is synced as in ipywidgets: `update` messages carry changed keys,
// with binary values lifted out into message buffers at `buffer_paths`
// (ipywidgets' _remove_buffers/_put_buffers).

export const WIDGET_PROTOCOL_VERSION = "2.1.0";
const WIDGET_TARGET = "jupyter.widget";
const CONTROL_TARGET = "jupyter.widget.control";
const VIEW_MIME = "application/vnd.jupyter.widget-view+json";

// The anywidget model the frontend instantiates. The module version is a
// semver range for the frontend's registry; anywidget sends "~major.minor.*"
// of its own version, and "*" accepts whichever release is installed.
const ANYWIDGET_MODEL = {
  _model_name: "AnyModel",
  _model_module: "anywidget",
  _model_module_version: "*",
  _view_name: "AnyView",
  _view_module: "anywidget",
  _view_module_version: "*",
  _view_count: null,
};

function isBinary(value) {
  return value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/** Copies `state` with binary values replaced by null, collecting them. */
export function removeBuffers(state) {
  const bufferPaths = [];
  const buffers = [];
  function walk(value, path) {
    if (isBinary(value)) {
      bufferPaths.push(path);
      buffers.push(toBytes(value));
      return null;
    }
    if (Array.isArray(value)) return value.map((item, i) => walk(item, [...path, i]));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, [...path, k])]));
    }
    return value;
  }
  return { state: walk(state, []), bufferPaths, buffers };
}

/** Puts received buffers back into `state` at `bufferPaths` (in place). */
export function putBuffers(state, bufferPaths = [], buffers = []) {
  bufferPaths.forEach((path, i) => {
    let obj = state;
    for (const key of path.slice(0, -1)) obj = obj[key];
    obj[path[path.length - 1]] = buffers[i];
  });
  return state;
}

class Widget {
  #comm;
  #state;
  #listeners = new Map(); // event -> Set<listener>

  constructor(comm, state, $display) {
    this.#comm = comm;
    this.#state = state;
    this[$display] = () => ({
      [VIEW_MIME]: { version_major: 2, version_minor: 1, model_id: this.id },
      "text/plain": `Widget(${this.id})`,
    });
  }

  get id() {
    return this.#comm.id;
  }

  get closed() {
    return this.#comm.closed;
  }

  get(key) {
    return this.#state[key];
  }

  /** set("key", value) or set({ key: value, ... }); syncs to the frontend. */
  set(keyOrChanges, value) {
    const changes = typeof keyOrChanges === "string" ? { [keyOrChanges]: value } : keyOrChanges;
    this.#apply(changes);
    if (this.closed) return;
    const { state, bufferPaths, buffers } = removeBuffers(changes);
    this.#comm.send({ method: "update", state, buffer_paths: bufferPaths }, { buffers });
  }

  on(event, listener) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(listener);
  }

  off(event, listener) {
    this.#listeners.get(event)?.delete(listener);
  }

  /** A custom message, delivered to the view's model.on("msg:custom"). */
  send(content, buffers = []) {
    this.#comm.send({ method: "custom", content }, { buffers });
  }

  close() {
    this.#comm.close();
  }

  /** The full state, as the frontend sees it (for request_state). */
  fullState() {
    return { ...ANYWIDGET_MODEL, ...this.#state };
  }

  async #emit(event, ...args) {
    for (const listener of this.#listeners.get(event) ?? []) await listener(...args);
  }

  async #apply(changes) {
    const previous = {};
    for (const [key, value] of Object.entries(changes)) {
      previous[key] = this.#state[key];
      this.#state[key] = value;
    }
    for (const key of Object.keys(changes)) await this.#emit(`change:${key}`, changes[key], previous[key]);
    await this.#emit("change", changes);
  }

  async _receive(msg) {
    const { method } = msg.data;
    if (method === "update") {
      const changes = putBuffers(msg.data.state ?? {}, msg.data.buffer_paths, msg.buffers);
      await this.#apply(changes);
    } else if (method === "request_state") {
      const { state, bufferPaths, buffers } = removeBuffers(this.fullState());
      this.#comm.send({ method: "update", state, buffer_paths: bufferPaths }, { buffers });
    } else if (method === "custom") {
      await this.#emit("msg:custom", msg.data.content, msg.buffers);
    }
  }
}

/**
 * @param {import("./comm.d.mts").CommApi} commApi
 * @param {symbol} $display
 */
export function createWidgetFactory(commApi, $display) {
  const live = new Map(); // model id -> Widget

  // The frontend opens this comm to restore every widget's state, e.g.
  // after the page reloads.
  commApi.registerTarget(CONTROL_TARGET, (control) => {
    control.onMsg((msg) => {
      if (msg.data.method !== "request_states") return;
      const states = {};
      for (const widget of live.values()) {
        const full = widget.fullState();
        states[widget.id] = {
          model_name: full._model_name,
          model_module: full._model_module,
          model_module_version: full._model_module_version,
          state: full,
        };
      }
      const { state, bufferPaths, buffers } = removeBuffers(states);
      control.send({ method: "update_states", states: state, buffer_paths: bufferPaths }, { buffers });
    });
  });

  return function widget({ esm, css, state = {} } = {}) {
    if (typeof esm !== "string") throw new TypeError("jupyter.widget needs an `esm` module string");
    const initial = { ...state };
    const full = {
      ...ANYWIDGET_MODEL,
      _esm: esm,
      ...(css === undefined ? {} : { _css: css }),
      _anywidget_id: "cdp-kernel.widget",
      ...initial,
    };
    const { state: wire, bufferPaths, buffers } = removeBuffers(full);
    const comm = commApi.open(WIDGET_TARGET, { state: wire, buffer_paths: bufferPaths }, {
      metadata: { version: WIDGET_PROTOCOL_VERSION },
      buffers,
    });
    const instance = new Widget(comm, { ...full }, $display);
    live.set(comm.id, instance);
    comm.onMsg((msg) => instance._receive(msg));
    comm.onClose(() => {
      live.delete(comm.id);
    });
    return instance;
  };
}
