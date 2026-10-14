// Interrupt probe: can a SECOND CDP session terminate a busy loop running in
// the first session's Runtime.evaluate?
import { spawn } from "node:child_process";
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
async function session(name) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  ws.addEventListener("close", () => console.log(name, "closed"));
  return (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
}
const a = await session("A");
await a("Runtime.enable");
let b;
try { b = await session("B"); console.log("second session opened"); } catch (e) { console.log("second session failed", e.message); }
const t0 = Date.now();
const busy = a("Runtime.evaluate", { expression: "await new Promise(r => setTimeout(r, 0)); let n=0; while(true){n++}", replMode: true, awaitPromise: true });
setTimeout(async () => {
  console.log("sending terminate via", b ? "B" : "A");
  const r = await (b ?? a)("Runtime.terminateExecution");
  console.log("terminate resp after", Date.now() - t0, "ms", JSON.stringify(r)); const x = await a("Runtime.evaluate", { expression: "typeof n === \"number\" ? \"n=\"+n : \"no n\"", replMode: true, awaitPromise: true }); console.log("post-interrupt eval:", JSON.stringify(x.result?.result)); const y = await a("Runtime.evaluate", { expression: "await new Promise(r=>setTimeout(()=>r(42),10))", replMode: true, awaitPromise: true }); console.log("timers alive:", JSON.stringify(y.result?.result)); child.kill(); process.exit(0);
}, 500);
setTimeout(() => { console.log("TIMEOUT: still busy after 5s"); child.kill(); process.exit(1); }, 5000);
const r = await busy;
console.log("busy returned after", Date.now() - t0, "ms", JSON.stringify(r).slice(0, 200));
const after = await a("Runtime.evaluate", { expression: "n", replMode: true });
console.log("after:", JSON.stringify(after.result?.result));
child.kill();
process.exit(0);
