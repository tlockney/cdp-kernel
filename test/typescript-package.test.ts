// Where the language service gets TypeScript (#513), src/typescript-package.ts.
// Installs are faked by linking the repo's own typescript into the cache.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aliasFor } from "../runtime/node-hooks.mjs";
import { KernelCore } from "../src/kernel-core.ts";
import { languageVersion } from "../src/kernel.ts";
import { LanguageService } from "../src/language-service.ts";
import { FakeChannels } from "./fake-channels.ts";
import {
  cachedTypeScript,
  findTypeScript,
  loadTypeScript,
  locateTypeScript,
  projectTypeScript,
  requireTypeScript,
  TYPESCRIPT_RANGE,
} from "../src/typescript-package.ts";

const repo = join(import.meta.dirname, "..");
const repoTypeScript = join(repo, "node_modules", "typescript");

function tempDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An empty npm cache for this test, via CDPK_CACHE_DIR. */
function useCache(t: TestContext): string {
  const cache = tempDir(t, "cdpk-ts-cache-");
  const before = process.env.CDPK_CACHE_DIR;
  process.env.CDPK_CACHE_DIR = cache;
  t.after(() => {
    if (before === undefined) delete process.env.CDPK_CACHE_DIR;
    else process.env.CDPK_CACHE_DIR = before;
  });
  return cache;
}

/** What ensureInstalledAsync would leave in `cache`. */
function linkCachedTypeScript(cache: string): void {
  mkdirSync(join(cache, "node_modules"), { recursive: true });
  symlinkSync(repoTypeScript, join(cache, "node_modules", aliasFor("typescript", TYPESCRIPT_RANGE)), "dir");
}

test("the cache range is package.json's typescript devDependency, below TypeScript 7", () => {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  assert.equal(pkg.dependencies?.typescript, undefined, "typescript is installed on first use, not with the package");
  assert.equal(pkg.devDependencies?.typescript, TYPESCRIPT_RANGE);
  assert.match(TYPESCRIPT_RANGE, /^\^6\./);
});

test("the notebook project's own typescript comes first, if its major is supported", (t) => {
  useCache(t);
  const found = projectTypeScript(repo);
  assert.equal(found?.from, "project");
  assert.match(found?.version ?? "", /^6\./);
  assert.deepEqual(findTypeScript(repo), found);

  const seven = tempDir(t, "cdpk-ts7-");
  mkdirSync(join(seven, "node_modules", "typescript"), { recursive: true });
  writeFileSync(join(seven, "node_modules", "typescript", "package.json"), '{ "name": "typescript", "version": "7.0.0" }');
  assert.equal(projectTypeScript(seven), null);
  assert.equal(findTypeScript(seven), null);
});

test("without one, typescript is installed once into the npm cache", async (t) => {
  const cache = useCache(t);
  const notebook = tempDir(t, "cdpk-nb-");
  assert.equal(cachedTypeScript(), null);
  const installs: unknown[] = [];
  const install = async (request: unknown) => {
    installs.push(request);
    linkCachedTypeScript(cache);
  };
  const found = await locateTypeScript(notebook, install);
  assert.equal(found.from, "cache");
  assert.deepEqual(installs, [{ name: "typescript", range: TYPESCRIPT_RANGE }]);
  assert.equal(requireTypeScript(found).version, found.version);
  // A second kernel (or kernel version) finds the same copy.
  assert.deepEqual(await locateTypeScript(notebook, install), found);
  assert.equal(installs.length, 1);
});

test("a failed install (offline) rejects", async (t) => {
  useCache(t);
  const notebook = tempDir(t, "cdpk-nb-");
  await assert.rejects(
    locateTypeScript(notebook, () => Promise.reject(new Error("npm install typescript failed: ENOTFOUND"))),
    /ENOTFOUND/,
  );
  assert.equal(cachedTypeScript(), null);
});

test("on a Deno host without one, Deno's own npm:typescript is used, not the npm CLI", async (t) => {
  useCache(t);
  const notebook = tempDir(t, "cdpk-nb-");
  const imported: string[] = [];
  const fake = { version: "6.9.9" };
  const ts = await loadTypeScript(notebook, {
    deno: true,
    importNpm: async (specifier) => {
      imported.push(specifier);
      return { default: fake };
    },
    install: () => Promise.reject(new Error("the npm CLI isn't used on Deno")),
  });
  assert.equal(ts, fake);
  assert.deepEqual(imported, [`npm:typescript@${TYPESCRIPT_RANGE}`]);
  // A project's own still comes first.
  assert.match((await loadTypeScript(repo, { deno: true, importNpm: () => Promise.reject(new Error("unused")) })).version, /^6\./);
});

test("on a Node host, a missing typescript is installed with the npm CLI", async (t) => {
  const cache = useCache(t);
  const notebook = tempDir(t, "cdpk-nb-");
  const ts = await loadTypeScript(notebook, {
    deno: false,
    importNpm: () => Promise.reject(new Error("npm: imports are Deno's")),
    install: async () => linkCachedTypeScript(cache),
  });
  assert.equal(ts.version, cachedTypeScript()?.version);
});

test("kernel_info reads the TypeScript version each time, so a cache install shows (#340)", async (t) => {
  const cache = useCache(t);
  const notebook = tempDir(t, "cdpk-nb-");
  const service = new LanguageService(
    { notebookDir: notebook, npmCache: "npm", deno: null, denoTypes: false, typeFiles: [], typePackages: [] },
  );
  t.after(() => service.close());
  const channels = new FakeChannels();
  const core = new KernelCore({
    runtime: "test",
    version: "0",
    // As src/kernel.ts gives it.
    get languageVersion() {
      return languageVersion(notebook, service);
    },
    channels,
    launchTarget: () => new Promise(() => {}),
    log: () => {},
    exit: () => {},
  });
  void core.run();
  const version = async () => {
    const id = channels.push("shell", "kernel_info_request");
    return ((await channels.replyOf("kernel_info_reply", id)).content.language_info as { version: string }).version;
  };
  assert.equal(await version(), "6");
  linkCachedTypeScript(cache);
  assert.equal(await version(), cachedTypeScript()?.version);
  assert.match(await version(), /^6\.\d+\.\d+/);
});

test("the language version: none without a service, else what the worker loaded first (#513)", async (t) => {
  useCache(t);
  const notebook = tempDir(t, "cdpk-nb-");
  assert.equal(languageVersion(repo, null), undefined);
  // A worker that loaded TypeScript where findTypeScript doesn't look (Deno's
  // cache, on a Deno host): the repo's, while the notebook has none.
  const service = new LanguageService({ notebookDir: repo, npmCache: "npm", deno: null, denoTypes: false, typeFiles: [], typePackages: [] });
  t.after(() => service.close());
  assert.equal(languageVersion(notebook, service), undefined);
  for (let i = 0; i < 100 && service.typescriptVersion === undefined; i++) {
    await service.complete("Math.", 5);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(languageVersion(notebook, service), projectTypeScript(repo)?.version);
});
