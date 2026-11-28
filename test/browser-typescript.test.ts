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

// The page's query string sets what the test varies: `plain` starts the
// kernel without the `typescript` option; `hang` makes the language
// Worker one that never answers; `nort` leaves out `runtimeTypes`;
// `budget`, `tsbase`, `module`, `libs` and `rt` set the option of those
// names (tsbase is a path on this origin).
const PAGE = `<!doctype html><script type="module">
import { startBrowserKernel } from "./kernel.js";
const q = new URLSearchParams(location.search);
// One record per language Worker made: whether the kernel terminated it.
globalThis.languageWorkers = [];
globalThis.logs = [];
const typescript = q.has("plain") ? undefined : {
  createWorker: () => {
    const worker = new Worker(q.has("hang") ? "./hang-worker.js" : "./language-worker.js", { type: "module" });
    const record = { terminated: false };
    globalThis.languageWorkers.push(record);
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => { record.terminated = true; terminate(); };
    return worker;
  },
  module: q.get("module") ?? "./ts/typescript.js",
  libs: q.get("libs") ?? "./ts/lib/",
  ...(q.has("nort") ? {} : { runtimeTypes: q.get("rt") ?? "./runtime/" }),
  budgetMs: q.has("budget") ? Number(q.get("budget")) : 20000,
  ...(q.has("tsbase") ? { base: location.origin + q.get("tsbase") } : {}),
};
const kernel = startBrowserKernel({
  createWorker: () => new Worker("./worker.js", { type: "module" }),
  ...(q.has("cdn") ? { cdn: location.origin + q.get("cdn") } : {}),
  log: (text) => globalThis.logs.push(text),
  typescript,
});
globalThis.kernel = kernel;
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
// Sends a shutdown_request and settles once the kernel has closed.
globalThis.shutdown = () => {
  kernel.send("control", { header: header("shutdown_request"), parent_header: {}, metadata: {}, content: { restart: false } });
  return kernel.closed;
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

/** Stands in for typescript.js with an API that isn't TypeScript's. */
const WRONG_TYPESCRIPT = "module.exports = { version: '0.0.0', createLanguageService() {} };";

/** Fake CDN packages for #525: esm.sh X-TypeScript-Types, package.json types, and untyped. */
const CDN_FILES: Record<string, { type: string; body: string; headers?: Record<string, string> }> = {
  // 1. esm.sh style: entry JS carries X-TypeScript-Types header pointing to index.d.ts,
  //    which pulls in a relative .d.ts via `.js` import and a `/// <reference path="..." />`.
  "/cdn/esm-pkg@1": {
    type: "text/javascript",
    headers: { "x-typescript-types": "/cdn/esm-pkg@1/index.d.ts" },
    body: "export function add(a, b) { return a + b; }\nexport function makePair(first) { return { first, second: 1, tag: true }; }\n",
  },
  "/cdn/esm-pkg@1/index.d.ts": {
    type: "text/plain",
    body: [
      '/// <reference path="./extra.d.ts" />',
      'export type { Pair } from "./types.js";',
      "export function add(a: number, b: number): number;",
      'export function makePair(first: string): import("./types.js").Pair;',
    ].join("\n"),
  },
  "/cdn/esm-pkg@1/types.d.ts": {
    type: "text/plain",
    body: "export interface Pair { first: string; second: number; tag: ExtraTag; }\n",
  },
  "/cdn/esm-pkg@1/extra.d.ts": {
    type: "text/plain",
    body: "declare type ExtraTag = boolean;\n",
  },
  // 2. CDN package.json `types` entry (no X-TypeScript-Types header).
  "/cdn/json-pkg@1": {
    type: "text/javascript",
    body: "export function greet(name) { return { greeting: 'hi ' + name, count: 1 }; }\n",
  },
  "/cdn/json-pkg@1/package.json": {
    type: "application/json",
    body: JSON.stringify({ name: "json-pkg", version: "1.0.0", types: "./dist/index.d.ts" }),
  },
  "/cdn/json-pkg@1/dist/index.d.ts": {
    type: "text/plain",
    body: 'import type { Greeting } from "./types";\nexport function greet(name: string): Greeting;\n',
  },
  "/cdn/json-pkg@1/dist/types.d.ts": {
    type: "text/plain",
    body: "export interface Greeting { greeting: string; count: number; }\n",
  },
  // 3. Package without any types: stays `any`.
  "/cdn/untyped-pkg@1": {
    type: "text/javascript",
    body: "export const value = 42;\n",
  },
  "/cdn/untyped-pkg@1/package.json": {
    type: "application/json",
    body: JSON.stringify({ name: "untyped-pkg", version: "1.0.0", main: "./index.js" }),
  },
};

async function serve(dir: string, requested: string[], state = { cdnOnline: true }): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    requested.push(path);
    const ts = typescriptFile(path);
    const runtime = /^\/runtime\/([\w.-]+\.d\.mts)$/.exec(path)?.[1];
    const cdn = path.startsWith("/cdn/") ? CDN_FILES[path] : undefined;
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    } else if (path === "/hang-worker.js") {
      res.writeHead(200, { "content-type": "text/javascript" }).end("self.onmessage = () => {};");
    } else if (path === "/wrong-typescript.js") {
      res.writeHead(200, { "content-type": "text/javascript" }).end(WRONG_TYPESCRIPT);
    } else if (ts !== null) {
      res.writeHead(200, { "content-type": path.endsWith(".js") ? "text/javascript" : "text/plain" }).end(ts);
    } else if (runtime !== undefined) {
      res.writeHead(200, { "content-type": "text/plain" }).end(readFileSync(join(ROOT, "runtime", runtime)));
    } else if (/^\/(?:kernel|worker|language-worker)\.js$/.test(path)) {
      res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(join(dir, path)));
    } else if (cdn !== undefined && state.cdnOnline) {
      res.writeHead(200, { "content-type": cdn.type, ...cdn.headers }).end(req.method === "HEAD" ? "" : cdn.body);
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
  const requested: string[] = [];
  const state = { cdnOnline: true };
  const { server, url } = await serve(dir, requested, state);
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
  /** The language Workers made so far, each with whether the kernel terminated it. */
  const workers = () => page.evaluate(() => (globalThis as unknown as { languageWorkers: { terminated: boolean }[] }).languageWorkers, null);
  const languageWorkers = async () => (await workers()).length;
  const logs = () => page.evaluate(() => (globalThis as unknown as { logs: string[] }).logs, null);
  const shutdown = () => page.evaluate(() => (globalThis as unknown as { shutdown(): Promise<void> }).shutdown(), null);
  const reload = async () => {
    await page.goto(url + query);
    await page.waitForFunction("globalThis.ready === true");
  };
  let comms = 0;
  /** Opens a comm to `target` and sends it `data`; the answer's data. */
  const ask = async (target: string, data: object): Promise<Record<string, unknown>> => {
    const commId = `c${++comms}`;
    await request("shell", "comm_open", { comm_id: commId, target_name: target, data: {} });
    const replies = await request("shell", "comm_msg", { comm_id: commId, data });
    return replies.find((r) => r.type === "comm_msg")!.content.data as Record<string, unknown>;
  };
  return { request, execute, languageWorkers, workers, logs, shutdown, reload, requested, state, ask };
}

const of = (replies: Reply[], type: string) => replies.filter((r) => r.type === type).map((r) => r.content);

/** `lib.*.d.ts` files TypeScript's lib.esnext.d.ts reaches, by the references the Worker follows. */
function esnextLibFiles(): string[] {
  const found = new Set<string>();
  const todo = ["lib.esnext.d.ts"];
  for (let name = todo.pop(); name !== undefined; name = todo.pop()) {
    if (found.has(name)) continue;
    found.add(name);
    for (const m of readFileSync(join(TS_LIB, name), "utf8").matchAll(/\/\/\/\s*<reference\s+lib="([^"]+)"\s*\/>/g)) todo.push(`lib.${m[1].toLowerCase()}.d.ts`);
  }
  return [...found];
}

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
    // Worker globals that are loosely typed rather than missing.
    "const ua: string = navigator.userAgent;",
    "const m: unknown = await WebAssembly.compile(new Uint8Array(8));",
    "const body: ReadableStream<Uint8Array> | null = r.body;",
    "const f = new FormData(); f.append('a', new Blob(['x']));",
    "const ev: Event = new Event('x'); const ch = new MessageChannel(); ch.port1.postMessage(ev.type);",
    "const ws: WebSocket = new WebSocket('wss://a.test'); ws.send('x');",
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

for (const [query, what] of [["?rt=./nort/", "runtime types that don't load"], ["?nort", "no runtimeTypes"]] as const) {
  test(`with ${what}, \`jupyter\` is any and the rest still works`, { skip }, async (t) => {
    const { execute, request, ask, logs } = await open(t, query);
    await execute("const n: number = 1; const u = { name: 'x' } as { name: string; age?: number };");
    const found = await until("diagnostics", async () => {
      const answer = await ask(DIAGNOSTICS, { request: 1, code: "const s: string = n;" });
      return answer.diagnostics === null ? undefined : answer;
    });
    assert.deepEqual((found.diagnostics as { code: number }[]).map((d) => d.code), [2322]);
    // `jupyter` is `any`: a name it lacks is no error.
    assert.deepEqual((await ask(DIAGNOSTICS, { request: 2, code: "jupyter.noSuchThing" })).diagnostics, []);
    const code = "u.";
    const reply = of(await request("shell", "complete_request", { code, cursor_pos: code.length }), "complete_reply")[0];
    assert.ok((reply.matches as string[]).includes("age"), String(reply.matches));
    assert.ok(!(await logs()).some((line) => /unavailable/.test(line)), (await logs()).join("\n"));
  });
}

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

/** The reply to a completion of `u.` for a value only the runtime knows `name` of. */
async function completeU(request: (c: string, t: string, b: object) => Promise<Reply[]>) {
  return of(await request("shell", "complete_request", { code: "u.", cursor_pos: 2 }), "complete_reply")[0];
}
const U = "const u = { name: 'x' } as { name: string; age?: number };";

test("shutting the kernel down ends the language Worker", { skip }, async (t) => {
  const { request, execute, workers, shutdown } = await open(t);
  await execute(U);
  await completeU(request);
  assert.deepEqual(await workers(), [{ terminated: false }]);
  await shutdown();
  assert.deepEqual(await workers(), [{ terminated: true }]);
});

test("budgetMs bounds how long a request waits for the Worker", { skip }, async (t) => {
  // A Worker that never answers: the budget decides when the kernel gives up on it.
  const { request, execute } = await open(t, "?hang&budget=50");
  await execute(U);
  const started = Date.now();
  const reply = await completeU(request);
  const took = Date.now() - started;
  assert.ok((reply.matches as string[]).includes("name"));
  assert.deepEqual(reply.metadata, {});
  // The default is 500 ms.
  assert.ok(took < 400, `took ${took} ms`);
});

test("typescript.base resolves the option's URLs", { skip }, async (t) => {
  // Relative to the page these would be /typescript.js and /lib/: not served.
  const { request, execute } = await open(t, "?tsbase=/ts/&module=typescript.js&libs=lib/&rt=../runtime/");
  await execute(U);
  await completeU(request);
  const typed = await until("typed completion", async () => {
    const reply = await completeU(request);
    return (reply.matches as string[]).includes("age") ? reply : undefined;
  });
  assert.ok(Array.isArray((typed.metadata as Record<string, unknown>)._jupyter_types_experimental));
});

for (const [name, query] of [
  ["a typescript.js that isn't there", "?module=./ts/missing.js"],
  ["lib files that aren't there", "?libs=./ts/nolibs/"],
  ["a typescript.js with another API", "?module=./wrong-typescript.js"],
] as const) {
  test(`${name}: the kernel answers from the runtime and starts no second Worker`, { skip }, async (t) => {
    const { request, execute, ask, languageWorkers, logs } = await open(t, query);
    await execute(U);
    const first = await completeU(request);
    assert.ok((first.matches as string[]).includes("name"));
    await until("the service to be marked unavailable", async () => ((await logs()).some((l) => /unavailable.*no typescript/.test(l)) ? true : undefined));
    const reply = await completeU(request);
    assert.ok((reply.matches as string[]).includes("name") && !(reply.matches as string[]).includes("age"));
    assert.deepEqual(reply.metadata, {});
    assert.deepEqual(await ask(DIAGNOSTICS, { request: 1, code: "const s: string = 1;" }), { request: 1, diagnostics: null });
    assert.deepEqual((await ask(LANGUAGE, { request: 2, op: "definition", cells: ["const a = 1;", "a"], cell: 1, cursor: 0 })).locations, null);
    assert.equal(await languageWorkers(), 1);
  });
}

test("each of TypeScript's lib files is fetched once", { skip }, async (t) => {
  const { request, execute, requested } = await open(t);
  await execute(U);
  await completeU(request);
  await until("typed completion", async () => ((await completeU(request)).matches as string[]).includes("age") ? true : undefined);
  const fetched = requested.filter((p) => /^\/ts\/lib\//.test(p)).map((p) => p.slice("/ts/lib/".length));
  assert.deepEqual([...fetched].sort(), esnextLibFiles().sort());
});

test("imported package types via X-TypeScript-Types and package.json give completion and errors, then work offline (#525)", { skip }, async (t) => {
  const { request, execute, ask, shutdown, reload, requested, state } = await open(t, "?cdn=/cdn/");
  // 1. esm.sh X-TypeScript-Types + referenced ./types.js and /// <reference path="./extra.d.ts" />
  await execute('import { add, makePair } from "npm:esm-pkg@1";\nconst pair = makePair("io");');
  const completePair = async () => of(await request("shell", "complete_request", { code: "pair.", cursor_pos: 5 }), "complete_reply")[0];
  const typed = await until("typed completion from X-TypeScript-Types", async () => {
    const reply = await completePair();
    return (reply.matches as string[]).includes("second") ? reply : undefined;
  });
  assert.ok((typed.matches as string[]).includes("first"));
  assert.ok((typed.matches as string[]).includes("tag"));

  const esmError = await until("type error from X-TypeScript-Types", async () => {
    const d = (await ask(DIAGNOSTICS, { request: 1, code: "const bad: string = add(1, 2);" })).diagnostics as { code: number }[] | null;
    return d && d.length > 0 ? d : undefined;
  });
  assert.deepEqual(esmError.map((d) => d.code), [2322]);

  // Tooltip and signature help also reflect the fetched types.
  const sig = await ask(LANGUAGE, { request: 2, op: "signature", code: "add(1, ", cursor: 7 });
  assert.match(String((sig.signature as { label: string } | null)?.label), /add\(a: number, b: number\): number/);

  // 2. CDN package.json `types` entry (no X-TypeScript-Types header) + referenced file
  await execute('import { greet } from "npm:json-pkg@1";\nconst g = greet("world");');
  const jsonTyped = await until("typed completion from package.json types", async () => {
    const reply = of(await request("shell", "complete_request", { code: "g.", cursor_pos: 2 }), "complete_reply")[0];
    return (reply.matches as string[]).includes("greeting") ? reply : undefined;
  });
  assert.ok((jsonTyped.matches as string[]).includes("count"));

  const jsonError = (await ask(DIAGNOSTICS, { request: 3, code: "const n: number = g.greeting;" })).diagnostics as { code: number }[];
  assert.deepEqual(jsonError.map((d) => d.code), [2322]);

  // 3. Offline after first load: disable CDN on the server and reload into a fresh Worker.
  await shutdown();
  state.cdnOnline = false;
  const beforeOffline = requested.length;
  await reload();

  const offlineCode = [
    'import { add, makePair } from "npm:esm-pkg@1";',
    'import { greet } from "npm:json-pkg@1";',
    "const bad: string = add(1, 2);",
    'const p: number = makePair("a").tag;',
    'const n: number = greet("a").greeting;',
  ].join("\n");
  const cachedOffline = await until("offline cached type errors", async () => {
    const d = (await ask(DIAGNOSTICS, { request: 4, code: offlineCode })).diagnostics as { code: number }[] | null;
    return d && d.length > 0 ? d : undefined;
  });
  assert.deepEqual(cachedOffline.map((d) => d.code), [2322, 2322, 2322]);

  const offlineComplete = 'import { makePair } from "npm:esm-pkg@1";\nmakePair("a").';
  const offlineReply = of(await request("shell", "complete_request", { code: offlineComplete, cursor_pos: offlineComplete.length }), "complete_reply")[0];
  assert.ok((offlineReply.matches as string[]).includes("second"));

  const offlineJsonComplete = 'import { greet } from "npm:json-pkg@1";\ngreet("a").';
  const offlineJsonReply = of(await request("shell", "complete_request", { code: offlineJsonComplete, cursor_pos: offlineJsonComplete.length }), "complete_reply")[0];
  assert.ok((offlineJsonReply.matches as string[]).includes("greeting"));

  const offlineRequests = requested.slice(beforeOffline);
  assert.deepEqual(
    offlineRequests.filter((p) => p.startsWith("/cdn/")),
    [],
    `expected no CDN requests offline, saw: ${offlineRequests.join(", ")}`,
  );
});

test("package type fetch failures stay silent and leave imports as any (#525)", { skip }, async (t) => {
  const { execute, ask, logs } = await open(t, "?cdn=/cdn/");
  await execute("const ok: number = 1;");
  await until("diagnostics ready", async () => {
    const ans = await ask(DIAGNOSTICS, { request: 1, code: "const s: string = ok;" });
    return ans.diagnostics === null ? undefined : ans;
  });

  // Untyped package (no types in package.json) and 404 package both stay `any`.
  const code = [
    'import { value } from "npm:untyped-pkg@1";',
    'import { nope } from "npm:missing-pkg@1";',
    "const x: string = value.anything(nope.alsoAny);",
  ].join("\n");
  assert.deepEqual((await ask(DIAGNOSTICS, { request: 2, code })).diagnostics, []);
  // Wait a bit to confirm async fetch failure does not break subsequent diagnostics or mark service unavailable.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual((await ask(DIAGNOSTICS, { request: 3, code })).diagnostics, []);
  const err = (await ask(DIAGNOSTICS, { request: 4, code: "const s: string = ok;" })).diagnostics as { code: number }[];
  assert.deepEqual(err.map((d) => d.code), [2322]);
  assert.ok(!(await logs()).some((line) => /unavailable/.test(line)), (await logs()).join("\n"));
});
