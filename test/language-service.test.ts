// The language-service worker and its time budget (#273), src/language-service.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { LanguageService } from "../src/language-service.ts";

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
    { notebookDir: repo, npmCache: true, typePackages: [{ name: "@types/node", range: "24" }] },
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

test("a request the worker can't answer within the budget gets null", async () => {
  const service = new LanguageService({ notebookDir: repo, npmCache: true, typePackages: [] }, { budgetMs: 1 });
  try {
    // Loading TypeScript alone takes longer than that.
    assert.equal(await service.complete("Math.", 5), null);
  } finally {
    service.close();
  }
});

test("cells run before the worker started are replayed to it", async () => {
  const service = new LanguageService({ notebookDir: repo, npmCache: true, typePackages: [] }, { budgetMs: 5_000 });
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
