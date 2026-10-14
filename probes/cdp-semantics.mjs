import { spawn } from "node:child_process";
// Basic CDP REPL semantics on a Node or Deno target (replMode, top-level
// await, dynamic import, bindings). The busy-loop interrupt at the end hangs
// by design: see interrupt.mjs for the working recipe.
const dir = new URL(".", import.meta.url).pathname;
const target = process.argv[2] ?? "node";
const args = target === "deno"
  ? ["run", "-A", "--inspect=127.0.0.1:0", "keepalive.mjs"]
  : ["--inspect=127.0.0.1:0", "keepalive.mjs"];
const child = spawn(target, args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
const url = await new Promise((res) => {
  let buf = "";
  child.stderr.on("data", (d) => { buf += d; const m = buf.match(/ws:\/\/[^\s]+/); if (m) res(m[0]); });
});
console.log("ws:", url);
const ws = new WebSocket(url);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === "Runtime.bindingCalled") console.log("BINDING", m.params.name, m.params.payload);
  else if (m.method === "Runtime.executionContextCreated") console.log("ctx", m.params.context.id, m.params.context.name);
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Runtime.enable");
await send("Runtime.addBinding", { name: "__kernel_emit" });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, replMode: true, awaitPromise: true });
  console.log(JSON.stringify(expression).slice(0, 60), "=>", JSON.stringify(r.result?.result ?? r.error).slice(0, 160),
    r.result?.exceptionDetails ? "EXC " + r.result.exceptionDetails.exception?.description?.split("\n")[0] : "");
};
await ev("const a = 1; a");
await ev("const a = 2; a");
await ev("let p = await Promise.resolve(42); p");
await ev("const fs = await import('node:fs'); typeof fs.readFileSync");
await ev("const m = await import('./mod.mjs'); m.hello");
await ev("__kernel_emit(JSON.stringify({t:'display'})); 'sent'");
const busy = ev("while(true){}");
setTimeout(() => send("Runtime.terminateExecution").then((r) => console.log("terminate resp", JSON.stringify(r))), 500);
await busy;
await ev("'alive after interrupt'");
await ev("throw new TypeError('boom')");
child.kill();
process.exit(0);
