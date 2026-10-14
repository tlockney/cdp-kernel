using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [ (name = "main", worker = .mainWorker), (name = "net", network = (allow = ["public", "private", "local"])) ],
  sockets = [ (name = "http", address = "127.0.0.1:18789", http = (), service = "main") ],
);

const mainWorker :Workerd.Worker = (
  modules = [ (name = "worker.js", esModule = embed "worker.js") ],
  compatibilityDate = "2026-09-01",
  globalOutbound = "net",
  bindings = [ (name = "UNSAFE", unsafeEval = void) ],
);
