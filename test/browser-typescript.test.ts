// The browser target's language service (#524): TypeScript in a Web Worker
// of its own, from files the page serves, answering completion, the
// diagnostics comm and the language comm through KernelCore as the Node
// targets do. The kernel (src/browser/mod.ts) and both Workers are
// bundled by scripts/build-browser.mjs and run in a headless browser, as
// in test/browser.test.ts, which this follows. Skipped without Playwright.
// TypeScript and the lib files are the ones devDependencies install.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINES = ["chromium", "webkit", "firefox"] as const;
type Engine = typeof ENGINES[number];
type Playwright = Record<Engine, { launch(options?: object): Promise<Browser> }>;
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

const engine = (process.env.CDPK_BROWSER || "chromium") as Engine;
if (!ENGINES.includes(engine)) throw new Error(`CDPK_BROWSER must be one of ${ENGINES.join(", ")}, not ${engine}`);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TS_LIB = join(ROOT, "node_modules/typescript/lib");

// `?plain` starts the kernel without the `typescript` option.
const PAGE = `<!doctype html><script type="module">
import { startBrowserKernel } from "./kernel.js";
globalThis.languageWorkers = 0;
const typescript = location.search.includes("plain") ? undefined : {
  createWorker: () => {
    globalThis.languageWorkers++;
    return new Worker("./language-worker.js", { type: "module" });
  },
  module: "./ts/typescript.js",
  libs: "./ts/lib/",
  runtimeTypes: "./runtime/",
  budgetMs: 20000,
};
const kernel = startBrowserKernel({
  createWorker: () => new Worker("./worker.js", { type: "module" }),
  log: () => {},
  typescript,
});
const seen = [];
kernel.onMessage((channel, msg) => seen.push({ channel, msg }));
function header(msg_type) {
  return { msg_id: crypto.randomUUID(), msg_type, session: "page", username: "test", date: new Date().toISOString(), version: "5.3" };
}
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
globalThis.ready = true;
</script>`;

/** What the page serves of TypeScript: typescript.js and the lib files, as `lib/` in the package has them. */
function typescriptFile(path: string): Buffer | null {
  const name = /^\/ts\/(?:lib\/)?([\w.]+)$/.exec(path)?.[1];
  if (name === undefined || !(name === "typescript.js" || /^lib\.[\w.]+\.d\.ts$/.test(name))) return null;
  try {
    return readFileSync(join(TS_LIB, name));
  } catch {
    return null;
  }
}

async function serve(dir: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const ts = typescriptFile(path);
    const runtime = /^\/runtime\/([\w.-]+\.d\.mts)$/.exec(path)?.[1];
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    } else if (ts !== null) {
      res.writeHead(200, { "content-type": path.endsWith(".js") ? "text/javascript" : "text/plain" }).end(ts);
    } else if (runtime !== undefined) {
      res.writeHead(200, { "content-type": "text/plain" }).end(readFileSync(join(ROOT, "runtime", runtime)));
    } else if (/^\/(?:kernel|worker|language-worker)\.js$/.test(path)) {
      res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(join(dir, path)));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

type Reply = { channel: string; type: string; content: Record<string, unknown> };

async function open(t: { after(fn: () => unknown): void }, query = "") {
  const dir = mkdtempSync(join(tmpdir(), "cdpk-browser-ts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync(process.execPath, [join(ROOT, "scripts/build-browser.mjs"), dir], { cwd: ROOT, stdio: "pipe" });
  const { server, url } = await serve(dir);
  t.after(() => server.close());
  const browser = await playwright![engine].launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(url + query);
  await page.waitForFunction("globalThis.ready === true");
  const request = (channel: string, type: string, content: object) =>
    page.evaluate(([ch, ty, co]) =>
      (globalThis as unknown as { request(a: unknown, b: unknown, c: unknown): Promise<Reply[]> }).request(ch, ty, co), [channel, type, content] as const);
  const execute = (code: string) => request("shell", "execute_request", { code, silent: false, store_history: true, allow_stdin: false, stop_on_error: true });
  const languageWorkers = () => page.evaluate(() => (globalThis as unknown as { languageWorkers: number }).languageWorkers, null);
  let comms = 0;
  /** Opens a comm to `target` and sends it `data`; the answer's data. */
  const ask = async (target: string, data: object): Promise<Record<string, unknown>> => {
    const commId = `c${++comms}`;
    await request("shell", "comm_open", { comm_id: commId, target_name: target, data: {} });
    const replies = await request("shell", "comm_msg", { comm_id: commId, data });
    return replies.find((r) => r.type === "comm_msg")!.content.data as Record<string, unknown>;
  };
  return { request, execute, languageWorkers, ask };
}

const of = (replies: Reply[], type: string) => replies.filter((r) => r.type === type).map((r) => r.content);

/** Calls `fn` until it returns something other than undefined: TypeScript takes a moment to load. */
async function until<T>(what: string, fn: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const found = await fn();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const DIAGNOSTICS = "cdp-kernel.diagnostics.v1";
const LANGUAGE = "cdp-kernel.language.v1";

test("typed completion and tooltips in the browser, from TypeScript and lib files the page serves", { skip }, async (t) => {
  const { request, execute, languageWorkers } = await open(t);
  assert.equal(await languageWorkers(), 0, "no Worker before the first request");
  // The runtime knows `name` only; the declared type adds `age`.
  await execute("const u = { name: 'x' } as { name: string; age?: number };");
  const code = "u.";
  const complete = async () => of(await request("shell", "complete_request", { code, cursor_pos: code.length }), "complete_reply")[0];

  // The first request starts the Worker, and answers from the runtime alone: TypeScript isn't loaded yet.
  const first = await complete();
  assert.equal(await languageWorkers(), 1);
  assert.ok((first.matches as string[]).includes("name") && !(first.matches as string[]).includes("age"), String(first.matches));
  assert.deepEqual(first.metadata, {});

  const typed = await until("typed completion", async () => {
    const reply = await complete();
    return (reply.matches as string[]).includes("age") ? reply : undefined;
  });
  assert.deepEqual((typed.matches as string[]).slice(0, 2), ["age", "name"]);
  assert.ok(Array.isArray((typed.metadata as Record<string, unknown>)._jupyter_types_experimental));

  // The tooltip has the declared type, and `jupyter` is typed by runtime/display.d.mts.
  const tip = of(await request("shell", "inspect_request", { code: "u", cursor_pos: 1, detail_level: 0 }), "inspect_reply")[0];
  assert.match(String((tip.data as Record<string, string>)["text/plain"]), /name: string/);
  const jupyter = of(await request("shell", "inspect_request", { code: "jupyter.display", cursor_pos: 15, detail_level: 0 }), "inspect_reply")[0];
  assert.match(String((jupyter.data as Record<string, string>)["text/plain"]), /display/);

  // language_info.version is the TypeScript the Worker loaded.
  const info = of(await request("shell", "kernel_info_request", {}), "kernel_info_reply")[0];
  assert.match((info.language_info as { version: string }).version, /^6\.\d+\.\d+/);
  assert.equal(await languageWorkers(), 1, "one Worker serves every request");
});

test("type errors from the diagnostics comm; Worker globals and unfetched packages are not errors", { skip }, async (t) => {
  const { execute, ask } = await open(t);
  await execute("const n: number = 1;");
  const bad = "const s: string = n;";
  // Until TypeScript has loaded the comm answers null, as on Node.
  const first = await ask(DIAGNOSTICS, { request: 1, code: bad });
  assert.deepEqual(first, { request: 1, diagnostics: null });

  const found = await until("diagnostics", async () => {
    const answer = await ask(DIAGNOSTICS, { request: 2, code: bad });
    return answer.diagnostics === null ? undefined : answer;
  });
  assert.deepEqual(found.diagnostics, [{
    start: 6,
    end: 7,
    severity: "error",
    code: 2322,
    message: "Type 'number' is not assignable to type 'string'.",
  }]);

  // What a cell reaches for in a Worker is declared, and a package whose types aren't fetched is `any`.
  const fine = [
    'import { format } from "npm:date-fns@4";',
    "console.log(format(new Date(), 'yyyy'), [1, 2].at(-1));",
    "const t: number = setTimeout(() => {}, 1);",
    "const r = await fetch(new URL('https://a.test'), { signal: AbortSignal.timeout(5) });",
    "const j: unknown = await r.json();",
    "const d = jupyter.html`<b>x</b>`;",
  ].join("\n");
  assert.deepEqual((await ask(DIAGNOSTICS, { request: 3, code: fine })).diagnostics, []);
  // `jupyter` is typed from runtime/display.d.mts: a name it lacks is an error.
  const typo = (await ask(DIAGNOSTICS, { request: 5, code: "jupyter.noSuchThing" })).diagnostics as { code: number }[];
  assert.deepEqual(typo.map((d) => d.code), [2339]);
  // A relative import that isn't there is still an error.
  const missing = (await ask(DIAGNOSTICS, { request: 4, code: "import x from './nope.ts';" })).diagnostics as { code: number }[];
  assert.equal(missing.length, 1);
  assert.equal(missing[0].code, 2307);
});

test("definition across cells from the language comm", { skip }, async (t) => {
  const { ask } = await open(t);
  // "😀" is two UTF-16 units and one code point: offsets are code points.
  const cells = ["const s = '😀'; function add(a: number, b: number) { return a + b; }", "add(1, 2);"];
  const request = { op: "definition", cells, cell: 1, cursor: 1 };
  const answer = await until("definition", async () => {
    const reply = await ask(LANGUAGE, { request: 1, ...request });
    return reply.locations === null ? undefined : reply;
  });
  const start = [...cells[0]].join("").indexOf("add");
  const cp = [...cells[0].slice(0, start)].length;
  assert.deepEqual(answer.locations, [{ cell: 0, start: cp, end: cp + 3 }]);

  const rename = await ask(LANGUAGE, { request: 2, ...request, op: "rename", newName: "sum" });
  assert.deepEqual(rename.edits, [
    { cell: 0, start: cp, end: cp + 3, text: "sum" },
    { cell: 1, start: 0, end: 3, text: "sum" },
  ]);
});

test("without the typescript option the kernel behaves as before", { skip }, async (t) => {
  const { request, execute, languageWorkers } = await open(t, "?plain");
  await execute("const u = { name: 'x' } as { name: string; age?: number };");

  // Completion is the runtime's alone, and no Worker is ever made.
  const reply = of(await request("shell", "complete_request", { code: "u.", cursor_pos: 2 }), "complete_reply")[0];
  assert.ok((reply.matches as string[]).includes("name") && !(reply.matches as string[]).includes("age"), String(reply.matches));
  assert.deepEqual(reply.metadata, {});
  // Both comms close, as for any unknown target.
  for (const [i, target] of [DIAGNOSTICS, LANGUAGE].entries()) {
    const replies = await request("shell", "comm_open", { comm_id: `p${i}`, target_name: target, data: {} });
    assert.deepEqual(of(replies, "comm_close"), [{ comm_id: `p${i}`, data: {} }]);
  }
  const info = of(await request("shell", "kernel_info_request", {}), "kernel_info_reply")[0];
  assert.equal((info.language_info as { version: string }).version, "6");
  assert.equal(await languageWorkers(), 0);
});
