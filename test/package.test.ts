import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { kernelArgv, moduleOrigin, RUNTIME_FILES, runtimeDir, VERSION } from "../src/package.ts";

const root = new URL("../", import.meta.url);

test("VERSION matches package.json and deno.jsonc", () => {
  const pkg: unknown = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  assert.equal((pkg as { version: string }).version, VERSION);
  // deno.jsonc allows comments; the version line is plain JSON.
  const m = /"version":\s*"([^"]+)"/.exec(readFileSync(new URL("deno.jsonc", root), "utf8"));
  assert.equal(m?.[1], VERSION);
});

test("every runtime file exists and is published", () => {
  const deno = readFileSync(new URL("deno.jsonc", root), "utf8");
  assert.match(deno, /"runtime\/\*\.mjs"/);
  for (const name of RUNTIME_FILES) assert.ok(existsSync(new URL(`runtime/${name}`, root)), name);
});

test("moduleOrigin: file, jsr (version pinned), other remote", () => {
  assert.deepEqual(moduleOrigin(pathToFileURL("/opt/cdpk/dist/main.js").href), {
    kind: "file",
    path: "/opt/cdpk/dist/main.js",
  });
  assert.deepEqual(moduleOrigin("https://jsr.io/@tlockney/cdp-kernel/0.1.0/src/main.ts"), {
    kind: "jsr",
    specifier: "jsr:@tlockney/cdp-kernel@0.1.0/cli",
  });
  assert.deepEqual(moduleOrigin("http://127.0.0.1:8000/src/main.ts"), {
    kind: "remote",
    url: "http://127.0.0.1:8000/src/main.ts",
  });
});

const ARGS = ["kernel", "--conn", "{connection_file}"];

test("kernelArgv: node host runs the file directly", () => {
  assert.deepEqual(kernelArgv("node", "/bin/node", { kind: "file", path: "/p/dist/main.js" }, ARGS), [
    "/bin/node",
    "/p/dist/main.js",
    ...ARGS,
  ]);
});

test("kernelArgv: deno host, checkout vs JSR", () => {
  assert.deepEqual(kernelArgv("deno", "/bin/deno", { kind: "file", path: "/p/src/main.ts" }, ARGS), [
    "/bin/deno",
    "run",
    "--allow-all",
    "--no-lock",
    "/p/src/main.ts",
    ...ARGS,
  ]);
  assert.deepEqual(
    kernelArgv("deno", "/bin/deno", { kind: "jsr", specifier: "jsr:@tlockney/cdp-kernel@0.1.0/cli" }, ARGS),
    ["/bin/deno", "run", "--allow-all", "--no-config", "--no-lock", "jsr:@tlockney/cdp-kernel@0.1.0/cli", ...ARGS],
  );
});

test("kernelArgv rejects origins it can't relaunch", () => {
  assert.throws(() => kernelArgv("node", "/bin/node", { kind: "jsr", specifier: "jsr:@x/y@1/cli" }, ARGS), /Deno/);
  assert.throws(() => kernelArgv("deno", "/bin/deno", { kind: "remote", url: "http://h/m.ts" }, ARGS), /npm or JSR/);
});

test("runtimeDir uses a file: directory in place", async () => {
  const dir = await runtimeDir(pathToFileURL("/opt/cdpk/runtime/").href, "/unused", () => {
    throw new Error("must not fetch");
  });
  assert.equal(dir, "/opt/cdpk/runtime/");
});

test("runtimeDir copies remote files once into a versioned cache", async (t) => {
  const cache = mkdtempSync(join(tmpdir(), "cdpk-cache-"));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const base = "https://jsr.io/@tlockney/cdp-kernel/0.1.0/runtime/";
  const fetched: string[] = [];
  const fake = (url: string) => {
    fetched.push(url);
    return Promise.resolve(`// ${url}\n`);
  };

  const dir = await runtimeDir(base, cache, fake);
  assert.ok(dir.startsWith(join(cache, "runtime", `${VERSION}-`)));
  assert.deepEqual(fetched, RUNTIME_FILES.map((name) => base + name));
  for (const name of RUNTIME_FILES) {
    assert.equal(readFileSync(join(dir, name), "utf8"), `// ${base}${name}\n`);
  }

  // Second call: cache hit, no fetches.
  fetched.length = 0;
  assert.equal(await runtimeDir(base, cache, fake), dir);
  assert.deepEqual(fetched, []);

  // A different release URL gets its own directory.
  const other = await runtimeDir("https://jsr.io/@tlockney/cdp-kernel/0.2.0/runtime/", cache, fake);
  assert.notEqual(other, dir);
});

test("runtimeDir leaves nothing behind when a fetch fails", async (t) => {
  const cache = mkdtempSync(join(tmpdir(), "cdpk-cache-"));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const failing = () => Promise.reject(new Error("offline"));
  await assert.rejects(runtimeDir("https://jsr.io/@x/y/1.0.0/runtime/", cache, failing), /offline/);
  const runtimeRoot = join(cache, "runtime");
  const entries = existsSync(runtimeRoot) ? readdirSync(runtimeRoot) : [];
  // The staging directory is removed too; nothing is left to be mistaken
  // for a complete copy.
  assert.deepEqual(entries, []);
});

