// The language-service worker and its time budget (#273), src/language-service.ts.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aliasFor } from "../runtime/node-hooks.mjs";
import { LanguageService, workerEntry } from "../src/language-service.ts";
import { TYPESCRIPT_RANGE } from "../src/typescript-package.ts";

const repo = join(import.meta.dirname, "..");

/** Asks until the worker answers (the first request starts it). */
async function completeWhenReady(service: LanguageService, code: string) {
  for (let i = 0; i < 100; i++) {
    const result = await service.complete(code, code.length);
    if (result !== null) return result;
  }
  throw new Error("the language service never answered");
}

test("the worker completes from executed cells and the target's type package", async () => {
  const logs: string[] = [];
  // The repo has @types/node, so nothing is installed.
  const service = new LanguageService(
    { notebookDir: repo, npmCache: "npm", deno: null, denoTypes: false, typeFiles: [], typePackages: [{ name: "@types/node", range: "24" }] },
    { budgetMs: 5_000, log: (text) => logs.push(text) },
  );
  try {
    service.addCell("const settings = { verbose: true, depth: 2 };");
    assert.deepEqual((await completeWhenReady(service, "settings.")).entries.map((e) => e.name), ["depth", "verbose"]);
    const node = await completeWhenReady(service, "process.versi");
    assert.deepEqual(node.entries.map((e) => e.name), ["version", "versions"]);
    service.reset();
    assert.deepEqual((await completeWhenReady(service, "settings.")).entries, []);
    assert.deepEqual(logs, []);
  } finally {
    service.close();
  }
});

test("the worker gives a cell's type errors (#514)", async () => {
  const service = new LanguageService(
    { notebookDir: repo, npmCache: "npm", deno: null, denoTypes: false, typeFiles: [], typePackages: [{ name: "@types/node", range: "24" }] },
    { budgetMs: 5_000 },
  );
  try {
    service.addCell("let total = 0;");
    let found = null;
    for (let i = 0; i < 100 && found === null; i++) found = await service.diagnostics("const n: string = total;\nprocess.version;");
    assert.deepEqual(found?.map((d) => [d.start, d.end, d.code]), [[6, 7, 2322]]);
  } finally {
    service.close();
  }
});

test("the worker answers signature, definition and rename requests (#522)", async () => {
  const service = new LanguageService(
    { notebookDir: repo, npmCache: "npm", deno: null, denoTypes: false, typeFiles: [], typePackages: [{ name: "@types/node", range: "24" }] },
    { budgetMs: 5_000 },
  );
  try {
    const cells = ["function add(a: number, b: number) { return a + b; }", "add(1, 2);\nprocess.cwd();"];
    service.addCell("function add(a: number, b: number) { return a + b; }");
    // The worker answers null until TypeScript and the type package are in.
    let found = null;
    for (let i = 0; i < 100 && found === null; i++) found = await service.signature("add(1, ", 7);
    assert.equal(found?.label, "add(a: number, b: number): number");
    assert.equal(found?.activeParameter, 1);
    // Definition and rename take the notebook's cells from the request, not the cells that ran.
    assert.deepEqual(await service.definition(cells, 1, 1), [{ cell: 0, start: 9, end: 12 }]);
    assert.deepEqual(await service.definition(cells, 1, cells[1].indexOf("process") + 1), []);
    assert.deepEqual(await service.rename(cells, 1, 1, "plus"), {
      edits: [{ cell: 0, start: 9, end: 12, text: "plus" }, { cell: 1, start: 0, end: 3, text: "plus" }],
    });
    const refused = await service.rename(cells, 1, cells[1].indexOf("process") + 1, "p");
    assert.ok(refused !== null && "error" in refused, JSON.stringify(refused));
  } finally {
    service.close();
  }
});

test("without the target's type package, signature, definition and rename answer null (#522)", async (t) => {
  // No npm on PATH: the package's install fails at once, as it does offline.
  bareNotebook(t, { PATH: "" });
  const service = new LanguageService(
    { notebookDir: repo, npmCache: "npm", deno: null, denoTypes: false, typeFiles: [], typePackages: [{ name: "@types/cdpk-no-such-package", range: "1" }] },
    { budgetMs: 5_000 },
  );
  try {
    const cells = ["const a = 1;", "a;"];
    // TypeScript is the repo's, so completion works while the package is missing.
    assert.deepEqual((await completeWhenReady(service, "Math.PI.toFix")).entries.map((e) => e.name), ["toFixed"]);
    for (let i = 0; i < 3; i++) {
      assert.equal(await service.signature("Math.max(", 9), null);
      assert.equal(await service.definition(cells, 1, 0), null);
      assert.equal(await service.rename(cells, 1, 0, "b"), null);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    service.close();
  }
});

test("a request the worker can't answer within the budget gets null", async () => {
  const service = new LanguageService({ notebookDir: repo, npmCache: "npm", deno: null, denoTypes: false, typeFiles: [], typePackages: [] }, { budgetMs: 1 });
  try {
    // Loading TypeScript alone takes longer than that.
    assert.equal(await service.complete("Math.", 5), null);
  } finally {
    service.close();
  }
});

test("cells run before the worker started are replayed to it", async () => {
  const service = new LanguageService({ notebookDir: repo, npmCache: "npm", deno: null, denoTypes: false, typeFiles: [], typePackages: [] }, { budgetMs: 5_000 });
  try {
    service.addCell("let early = 'x';");
    service.close();
    service.addCell("let later = 1;");
    assert.deepEqual((await completeWhenReady(service, "ear")).entries.map((e) => e.name), ["early"]);
    assert.deepEqual((await completeWhenReady(service, "lat")).entries.map((e) => e.name), ["later"]);
  } finally {
    service.close();
  }
});

test("a worker module that isn't a local file starts through a data: URL", () => {
  const local = new URL("file:///pkg/dist/language-service-worker.js");
  assert.equal(workerEntry(local), local);
  const remote = workerEntry(new URL("https://jsr.io/@tlockney/cdp-kernel/0.6.0/src/language-service-worker.ts"));
  assert.equal(remote.protocol, "data:");
  assert.equal(
    decodeURIComponent(remote.href.slice("data:text/javascript,".length)),
    `import "https://jsr.io/@tlockney/cdp-kernel/0.6.0/src/language-service-worker.ts";`,
  );
});

test("the worker answers quick info", async () => {
  const service = new LanguageService({ notebookDir: repo, npmCache: "npm", deno: null, denoTypes: false, typeFiles: [], typePackages: [] }, { budgetMs: 5_000 });
  try {
    service.addCell("/** The answer. */\nconst answer = 42;");
    let info: string | null = null;
    for (let i = 0; i < 100 && info === null; i++) info = await service.quickInfo("answer", 6);
    assert.equal(info, "const answer: 42\nThe answer.");
  } finally {
    service.close();
  }
});

/**
 * A notebook directory without typescript and an empty npm cache, set in
 * the environment the next worker starts with.
 */
function bareNotebook(t: TestContext, env: Record<string, string> = {}): { notebook: string; cache: string } {
  const notebook = mkdtempSync(join(tmpdir(), "cdpk-nb-"));
  const cache = mkdtempSync(join(tmpdir(), "cdpk-ts-cache-"));
  const before = { ...process.env };
  Object.assign(process.env, { CDPK_CACHE_DIR: cache, ...env });
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    rmSync(notebook, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  });
  return { notebook, cache };
}

test("without the project's typescript, the worker uses the npm cache's (#513)", async (t) => {
  const { notebook, cache } = bareNotebook(t);
  mkdirSync(join(cache, "node_modules"));
  symlinkSync(join(repo, "node_modules", "typescript"), join(cache, "node_modules", aliasFor("typescript", TYPESCRIPT_RANGE)), "dir");
  const logs: string[] = [];
  const service = new LanguageService(
    { notebookDir: notebook, npmCache: "npm", deno: null, denoTypes: false, typeFiles: [], typePackages: [] },
    { budgetMs: 5_000, log: (text) => logs.push(text) },
  );
  try {
    service.addCell("const settings = { verbose: true, depth: 2 };");
    assert.deepEqual((await completeWhenReady(service, "settings.")).entries.map((e) => e.name), ["depth", "verbose"]);
    assert.deepEqual(logs, []);
  } finally {
    service.close();
  }
});

test("offline with an empty cache, requests get null and the kernel logs one line (#513)", async (t) => {
  // No npm on PATH: the install fails at once, as it does offline.
  const { notebook } = bareNotebook(t, { PATH: "" });
  const logs: string[] = [];
  const service = new LanguageService(
    { notebookDir: notebook, npmCache: "npm", deno: null, denoTypes: false, typeFiles: [], typePackages: [] },
    { budgetMs: 5_000, log: (text) => logs.push(text) },
  );
  try {
    const deadline = Date.now() + 30_000;
    while (logs.length === 0 && Date.now() < deadline) {
      assert.equal(await service.complete("Math.", 5), null);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (let i = 0; i < 3; i++) assert.equal(await service.complete("Math.", 5), null);
    assert.equal(await service.diagnostics("const n: string = 1"), null);
    assert.equal(await service.signature("Math.max(", 9), null);
    assert.equal(await service.definition(["const a = 1;", "a;"], 1, 0), null);
    assert.equal(await service.rename(["const a = 1;", "a;"], 1, 0, "b"), null);
    assert.equal(logs.length, 1, logs.join("\n"));
    assert.match(logs[0], /^typed completion unavailable: no typescript: npm install typescript@\^6\.0\.3 failed: .+$/);
  } finally {
    service.close();
  }
});
