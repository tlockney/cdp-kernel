// The browser target end to end: the kernel (src/browser/mod.ts) and its
// driver Worker, bundled by scripts/build-browser.mjs, in headless
// Chromium, with a page standing in for the frontend. Skipped without
// Playwright.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Playwright = { chromium: { launch(options?: object): Promise<Browser> } };
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };
type Page = {
  goto(url: string): Promise<unknown>;
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
  waitForFunction(expression: string): Promise<unknown>;
};

let playwright: Playwright | null = null;
try {
  playwright = await import("playwright" as string) as Playwright;
} catch {
  // Not installed: skip.
}
const skip = playwright === null ? "needs the playwright package" : false;

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const PAGE = `<!doctype html><script type="module">
import { startBrowserKernel } from "./kernel.js";
const kernel = startBrowserKernel({
  createWorker: () => new Worker("./worker.js", { type: "module" }),
  cdn: location.origin + "/cdn/",
  log: () => {},
});
const seen = [];
kernel.onMessage((channel, msg) => seen.push({ channel, msg }));
function header(msg_type) {
  return { msg_id: crypto.randomUUID(), msg_type, session: "page", username: "test", date: new Date().toISOString(), version: "5.3" };
}
// Sends a request; resolves with every message about it once the kernel is idle again.
globalThis.request = (channel, msgType, content) => {
  const h = header(msgType);
  kernel.send(channel, { header: h, parent_header: {}, metadata: {}, content });
  return new Promise((resolve) => {
    const poll = () => {
      const mine = seen.filter((m) => m.msg.parent_header.msg_id === h.msg_id);
      const idle = mine.some((m) => m.msg.header.msg_type === "status" && m.msg.content.execution_state === "idle");
      if (idle) resolve(mine.map((m) => ({ channel: m.channel, type: m.msg.header.msg_type, content: m.msg.content })));
      else setTimeout(poll, 10);
    };
    poll();
  });
};
globalThis.execute = (code) => request("shell", "execute_request", { code, silent: false, store_history: true, allow_stdin: false, stop_on_error: true });
globalThis.ready = true;
</script>`;

const FILES: Record<string, { type: string; body: string }> = {
  "/local.mjs": { type: "text/javascript", body: "export const where = 'local';" },
  "/cdn/left-pad@1": { type: "text/javascript", body: "export default (s, n) => String(s).padStart(n);" },
};

async function serve(dir: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const file = FILES[path];
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    } else if (file) {
      res.writeHead(200, { "content-type": file.type }).end(file.body);
    } else if (/^\/(?:kernel|worker)\.js$/.test(path)) {
      res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(join(dir, path)));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

type Reply = { channel: string; type: string; content: Record<string, unknown> };

async function open(t: { after(fn: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), "cdpk-browser-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync(process.execPath, [join(ROOT, "scripts/build-browser.mjs"), dir], { cwd: ROOT, stdio: "pipe" });
  const { server, url } = await serve(dir);
  t.after(() => server.close());
  const browser = await playwright!.chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForFunction("globalThis.ready === true");
  const execute = (code: string) => page.evaluate((c) => (globalThis as unknown as { execute(c: string): Promise<Reply[]> }).execute(c), code);
  const request = (channel: string, type: string, content: object) =>
    page.evaluate(([ch, ty, co]) =>
      (globalThis as unknown as { request(a: unknown, b: unknown, c: unknown): Promise<Reply[]> }).request(ch, ty, co), [channel, type, content] as const);
  return { execute, request };
}

const of = (replies: Reply[], type: string) => replies.filter((r) => r.type === type).map((r) => r.content);
const text = (replies: Reply[], name: string) => of(replies, "stream").filter((c) => c.name === name).map((c) => c.text).join("");
const result = (replies: Reply[]) => (of(replies, "execute_result")[0]?.data as Record<string, string> | undefined)?.["text/plain"];

test("cells run in a browser Worker, with types stripped and state kept", { skip }, async (t) => {
  const { execute, request } = await open(t);

  const info = of(await request("shell", "kernel_info_request", {}), "kernel_info_reply")[0];
  assert.equal(info.implementation, "cdp-kernel");
  assert.equal((info.language_info as { name: string }).name, "typescript");

  let r = await execute("const x: number = 2;\nx * 21");
  assert.equal(of(r, "execute_reply")[0].status, "ok");
  assert.equal(result(r), "42");

  r = await execute("x + 1");
  assert.equal(result(r), "3");
  assert.match(String(of(r, "execute_reply")[0].execution_count), /^2$/);

  r = await execute(`console.log("hi", { a: [1, "b"] }); console.error("oops")`);
  assert.equal(text(r, "stdout"), "hi { a: [ 1, 'b' ] }\n");
  assert.equal(text(r, "stderr"), "oops\n");

  r = await execute("await jupyter.display(jupyter.html`<b>bold</b>`)");
  assert.equal((of(r, "display_data")[0].data as Record<string, string>)["text/html"], "<b>bold</b>");

  r = await execute(`throw new TypeError("bad")`);
  const reply = of(r, "execute_reply")[0];
  assert.equal(reply.status, "error");
  assert.equal(reply.ename, "TypeError");
  assert.equal(of(r, "error")[0].evalue, "bad");

  r = await execute(`import pad from "npm:left-pad@1";\nimport { where } from "./local.mjs";\npad(where, 7)`);
  assert.equal(result(r), "'  local'");

  const completions = of(await request("shell", "complete_request", { code: "Mat", cursor_pos: 3 }), "complete_reply")[0];
  assert.ok((completions.matches as string[]).includes("Math"), String(completions.matches));
});

test("interrupting a busy cell restarts the Worker", { skip }, async (t) => {
  const { execute, request } = await open(t);
  await execute("var kept = 1");
  const busy = execute("while (true) {}");
  await new Promise((r) => setTimeout(r, 300));
  const interrupt = await request("control", "interrupt_request", {});
  assert.equal(of(interrupt, "interrupt_reply")[0].status, "ok");
  const r = await busy;
  assert.equal(of(r, "execute_reply")[0].status, "error");
  assert.equal(of(r, "execute_reply")[0].ename, "Interrupted");
  assert.match(text(r, "stderr"), /Worker was stopped/);

  // A new Worker, without the old one's state.
  assert.equal(result(await execute("typeof kept")), "'undefined'");
  assert.equal(result(await execute("1 + 1")), "2");
});

test("interrupting a waiting cell keeps the Worker's state", { skip }, async (t) => {
  const { execute, request } = await open(t);
  await execute("var kept = 'yes'");
  const waiting = execute("await new Promise(() => {})");
  await new Promise((r) => setTimeout(r, 300));
  await request("control", "interrupt_request", {});
  assert.equal(of(await waiting, "execute_reply")[0].ename, "Interrupted");
  assert.equal(result(await execute("kept")), "'yes'");
});
