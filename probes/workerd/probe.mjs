// Can workerd host a CDP-driven notebook kernel? Compare inspector
// evaluation (Runtime.evaluate, replMode) with request-scoped evaluation
// (a fetch handler running UnsafeEval.newAsyncFunction).
import { spawn } from "node:child_process";
const dir = new URL(".", import.meta.url).pathname;
const child = spawn(dir + "node_modules/.bin/workerd", ["serve", "config.capnp", "--inspector-addr=127.0.0.1:19239", "--verbose", "--experimental"], {
  cwd: dir,
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 100; i++) {
  try {
    targets = await (await fetch("http://127.0.0.1:19239/json/list")).json();
    break;
  } catch { await sleep(100); }
}
console.log("json/list:", JSON.stringify(targets));
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
let id = 0; const pending = new Map(); const contexts = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === "Runtime.executionContextCreated") contexts.push(m.params.context);
  else if (m.method === "Runtime.consoleAPICalled") console.log("  console:", m.params.args.map((a) => a.value ?? a.description).join(" "));
  else if (m.method === "Runtime.bindingCalled") console.log("  BINDING:", m.params.payload);
});
const send = (method, params = {}, timeout = 5000) => new Promise((r) => {
  const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); r({ timeout: true }); } }, timeout);
});
console.log("Runtime.enable:", JSON.stringify(await send("Runtime.enable")).slice(0, 120));
await sleep(200);
console.log("contexts:", JSON.stringify(contexts));
console.log("addBinding:", JSON.stringify(await send("Runtime.addBinding", { name: "__cdpk_send" })));

async function ev(label, expression, timeout = 5000) {
  const r = await send("Runtime.evaluate", { expression, replMode: true, awaitPromise: true, contextId: contexts[0].id }, timeout);
  const out = r.timeout ? "TIMEOUT" : r.error ? "CDP ERROR " + r.error.message
    : r.result.exceptionDetails ? "EXC " + (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text).split("\n")[0]
    : JSON.stringify(r.result.result.value ?? r.result.result.description);
  console.log(`  [inspector] ${label}: ${out}`);
}
console.log("--- inspector evaluation (outside any request)");
await ev("const + value", "const a = 1; a + 1");
await ev("redeclare const", "const a = 2; a");
await ev("top-level await (resolved)", "await Promise.resolve(42)");
await ev("setTimeout", "await new Promise((r) => setTimeout(() => r('timer fired'), 10))", 3000);
await ev("fetch", "(await fetch('http://127.0.0.1:18789/')).status", 3000);
await ev("eval inside cell", "eval('1 + 2')");
await ev("new Function", "new Function('return 3')()");
await ev("dynamic import", "(await import('node:path')).join('a','b')");
await ev("binding call", "__cdpk_send('hi from workerd'); 'sent'");
await ev("crypto.randomUUID", "crypto.randomUUID().length");
await ev("globalThis keys", "Object.keys(globalThis).length");

console.log("--- request-scoped evaluation (UnsafeEval inside fetch)");
async function req(label, code) {
  const res = await fetch("http://127.0.0.1:18789/eval", { method: "POST", body: code });
  console.log(`  [request]   ${label}: ${await res.text()}`);
}
await req("timer", "return await new Promise((r) => setTimeout(() => r('timer fired'), 10))");
await req("fetch", "return (await fetch('http://127.0.0.1:18789/')).status");
await req("subrequest text", "return await (await fetch('http://127.0.0.1:18789/')).text()");
await req("globals persist across requests (set)", "globalThis.kept = 'state'; return 'set'");
await req("globals persist across requests (get)", "return globalThis.kept");

console.log("--- interrupt");
const busy = send("Runtime.evaluate", { expression: "await new Promise((r) => setTimeout(r, 0)); while (true) {}", replMode: true, awaitPromise: true, contextId: contexts[0].id }, 4000);
await sleep(300);
const ws2 = new WebSocket(targets[0].webSocketDebuggerUrl);
let second = "opened";
await new Promise((r) => { ws2.addEventListener("open", r); ws2.addEventListener("error", () => { second = "refused"; r(); }); });
console.log("  second CDP session:", second);
let id2 = 0; const p2 = new Map();
ws2.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (p2.has(m.id)) { p2.get(m.id)(m); p2.delete(m.id); } });
const send2 = (method, params = {}) => new Promise((r) => { const i = ++id2; p2.set(i, r); ws2.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p2.has(i)) { p2.delete(i); r({ timeout: true }); } }, 2000); });
console.log("  terminateExecution (second session):", JSON.stringify(await send2("Runtime.terminateExecution")));
console.log("  busy evaluate:", JSON.stringify(await busy).slice(0, 160));
await ev("after interrupt", "'alive'");
child.kill();
console.log("--- workerd log tail\n" + log.split("\n").slice(-8).join("\n"));
process.exit(0);
