import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  dependencyCutoff,
  isInsideNodeModules,
  kernelArgv,
  moduleOrigin,
  RELEASE_DATE,
  RUNTIME_FILES,
  runtimeDir,
  VERSION,
} from "../src/package.ts";

const root = new URL("../", import.meta.url);

test("VERSION matches package.json and deno.jsonc", () => {
  const pkg: unknown = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  assert.equal((pkg as { version: string }).version, VERSION);
  // deno.jsonc allows comments; the version line is plain JSON.
  const m = /"version":\s*"([^"]+)"/.exec(readFileSync(new URL("deno.jsonc", root), "utf8"));
  assert.equal(m?.[1], VERSION);
});

test("no other source file hardcodes a version", () => {
  // kernel_info once reported a hardcoded "0.1.0" (#22). Everything should
  // use VERSION from src/package.ts; these literals are other protocols' or
  // placeholders, not cdp-kernel's own version.
  const allowed = new Map([
    ["runtime/widget.mjs", ["2.1.0"]], // ipywidgets message protocol
    ["runtime/deno-compat.mjs", ["0.0.0-cdp-kernel"]], // Deno.version.deno placeholder
  ]);
  const files = [
    ...readdirSync(new URL("src/", root)).filter((f) => f.endsWith(".ts")).map((f) => `src/${f}`),
    ...readdirSync(new URL("runtime/", root)).filter((f) => f.endsWith(".mjs")).map((f) => `runtime/${f}`),
  ].filter((f) => f !== "src/package.ts");
  const found: string[] = [];
  for (const file of files) {
    const text = readFileSync(new URL(file, root), "utf8");
    for (const [, literal] of text.matchAll(/["'`](\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)["'`]/g)) {
      if (!allowed.get(file)?.includes(literal)) found.push(`${file}: "${literal}"`);
    }
  }
  assert.deepEqual(found, []);
});

test("every runtime file exists and is published", () => {
  const deno = readFileSync(new URL("deno.jsonc", root), "utf8");
  assert.match(deno, /"runtime\/\*\.mjs"/);
  for (const name of RUNTIME_FILES) assert.ok(existsSync(new URL(`runtime/${name}`, root)), name);
});

test("moduleOrigin: file, jsr (version pinned), other remote", () => {
  assert.deepEqual(moduleOrigin(pathToFileURL("/opt/cdpk/dist/main.js").href), {
    kind: "file",
    path: resolve("/opt/cdpk/dist/main.js"), // D:\opt\... on Windows (#32)
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
    [
      "/bin/deno",
      "run",
      "--allow-all",
      "--no-config",
      "--no-lock",
      `--min-dep-age=${dependencyCutoff()}`,
      "jsr:@tlockney/cdp-kernel@0.1.0/cli",
      ...ARGS,
    ],
  );
});

test("dependencyCutoff is two days after the release, across month and year ends (#12)", () => {
  assert.equal(dependencyCutoff("2026-10-15"), "2026-10-17");
  assert.equal(dependencyCutoff("2026-10-31"), "2026-11-02");
  assert.equal(dependencyCutoff("2026-12-31"), "2027-01-02");
  assert.equal(dependencyCutoff("2028-02-28"), "2028-03-01", "leap year");
  assert.throws(() => dependencyCutoff("not-a-date"), /not a date/);
});

test("RELEASE_DATE is a YYYY-MM-DD day, and the JSR kernelspec carries its cutoff", () => {
  assert.match(RELEASE_DATE, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(dependencyCutoff(), dependencyCutoff(RELEASE_DATE));
  const argv = kernelArgv("deno", "/bin/deno", { kind: "jsr", specifier: "jsr:@tlockney/cdp-kernel@9.9.9/cli" }, ARGS);
  assert.ok(argv.includes(`--min-dep-age=${dependencyCutoff(RELEASE_DATE)}`), argv.join(" "));
  const checkout = kernelArgv("deno", "/bin/deno", { kind: "file", path: "/p/src/main.ts" }, ARGS);
  assert.ok(!checkout.some((a) => a.startsWith("--min-dep-age")), "a checkout resolves nothing from JSR");
});

test("kernelArgv rejects origins it can't relaunch", () => {
  assert.throws(() => kernelArgv("node", "/bin/node", { kind: "jsr", specifier: "jsr:@x/y@1/cli" }, ARGS), /Deno/);
  assert.throws(() => kernelArgv("deno", "/bin/deno", { kind: "remote", url: "http://h/m.ts" }, ARGS), /npm or JSR/);
});

test("runtimeDir uses a file: directory in place", async () => {
  const dir = await runtimeDir(pathToFileURL("/opt/cdpk/runtime/").href, "/unused", () => {
    throw new Error("must not fetch");
  });
  assert.equal(dir, resolve("/opt/cdpk/runtime") + sep);
});

test("isInsideNodeModules spots an npm-installed runtime directory", () => {
  assert.equal(isInsideNodeModules(pathToFileURL("/p/node_modules/@tlockney/cdp-kernel/runtime/").href), true);
  assert.equal(isInsideNodeModules(pathToFileURL("/src/cdp-kernel/runtime/").href), false);
  assert.equal(isInsideNodeModules("https://jsr.io/@tlockney/cdp-kernel/0.1.1/runtime/"), false);
});

test("runtimeDir copies a file: directory when asked (npm install, Deno target)", async (t) => {
  // Deno resolves imports from modules under node_modules as npm-package
  // imports, without the project's import map, so a Deno target must not
  // load its bootstrap from there.
  const work = mkdtempSync(join(tmpdir(), "cdpk-copy-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const installed = join(work, "node_modules", "@tlockney", "cdp-kernel", "runtime");
  mkdirSync(installed, { recursive: true });
  for (const name of RUNTIME_FILES) writeFileSync(join(installed, name), `// ${name}\n`);
  const cache = join(work, "cache");

  const dir = await runtimeDir(pathToFileURL(installed + "/").href, cache, undefined, { copy: true });
  assert.ok(dir.startsWith(join(cache, "runtime", `${VERSION}-`)), dir);
  for (const name of RUNTIME_FILES) assert.equal(readFileSync(join(dir, name), "utf8"), `// ${name}\n`);
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

