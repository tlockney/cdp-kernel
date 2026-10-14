// What does Bun's inspector (WebKit Inspector Protocol) offer a kernel?
import { spawn } from "node:child_process";
const dir = new URL(".", import.meta.url).pathname;
const child = spawn("bun", ["--inspect=127.0.0.1:19240/cdpk", "keepalive.mjs"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
let banner = "";
child.stdout.on("data", (d) => (banner += d));
child.stderr.on("data", (d) => (banner += d));
await new Promise((r) => setTimeout(r, 1500));
console.log("banner:", JSON.stringify(banner.slice(0, 300)));
const ws = new WebSocket("ws://127.0.0.1:19240/cdpk");
await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
let id = 0; const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) console.log("  event:", m.method);
});
const send = (method, params = {}) => new Promise((r) => {
  const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); r({ timeout: true }); } }, 3000);
});
const show = (label, r) => console.log(`  ${label}:`, JSON.stringify(r.result ?? r.error ?? r).slice(0, 200));
show("Runtime.enable", await send("Runtime.enable"));
show("Runtime.addBinding", await send("Runtime.addBinding", { name: "__cdpk_send" }));
show("evaluate const", await send("Runtime.evaluate", { expression: "const a = 1; a + 1" }));
show("evaluate redeclare", await send("Runtime.evaluate", { expression: "const a = 2; a" }));
show("evaluate replMode (CDP-only)", await send("Runtime.evaluate", { expression: "const b = 3; b", replMode: true }));
show("evaluate await (awaitPromise)", await send("Runtime.evaluate", { expression: "Promise.resolve(42)", awaitPromise: true, returnByValue: true }));
show("top-level await", await send("Runtime.evaluate", { expression: "await Promise.resolve(42)" }));
show("dynamic import", await send("Runtime.evaluate", { expression: "import('node:path').then(p => p.join('a','b'))", awaitPromise: true, returnByValue: true }));
show("globalLexicalScopeNames", await send("Runtime.globalLexicalScopeNames"));
show("Runtime.terminateExecution", await send("Runtime.terminateExecution"));
child.kill();
process.exit(0);
