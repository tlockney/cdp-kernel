// The stable parts of a kernelspec: the runtime path and the package copy (#508).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { createRequire } from "node:module";
import {
  jupyterDataDir,
  pinnedByManager,
  pruneStableCopies,
  stableExecPath,
  stableOrigin,
  stablePackage,
} from "../src/stable-install.ts";

// ---- stableExecPath

const all = () => true;
const none = () => false;

test("stableExecPath: mise installs map to the shim", () => {
  const p = "/Users/x/.local/share/mise/installs/node/22.18.0/bin/node";
  assert.equal(stableExecPath(p, { exists: all, platform: "darwin", env: {} }), "/Users/x/.local/share/mise/shims/node");
  assert.equal(
    stableExecPath("/data/m/installs/deno/2.5.0/bin/deno", { exists: all, platform: "linux", env: { MISE_DATA_DIR: "/data/m" } }),
    "/data/m/shims/deno",
  );
});

test("stableExecPath: asdf installs map to the shim", () => {
  const p = "/home/x/.asdf/installs/nodejs/22.18.0/bin/node";
  assert.equal(stableExecPath(p, { exists: all, platform: "linux", env: {} }), "/home/x/.asdf/shims/node");
  assert.equal(
    stableExecPath("/opt/asdf-data/installs/nodejs/22.18.0/bin/node", { exists: all, platform: "linux", env: { ASDF_DATA_DIR: "/opt/asdf-data" } }),
    "/opt/asdf-data/shims/node",
  );
});

test("stableExecPath: volta tool images map to its bin", () => {
  assert.equal(
    stableExecPath("/Users/x/.volta/tools/image/node/22.18.0/bin/node", { exists: all, platform: "darwin", env: {} }),
    "/Users/x/.volta/bin/node",
  );
});

test("stableExecPath: Homebrew Cellar maps to the prefix's bin", () => {
  assert.equal(
    stableExecPath("/opt/homebrew/Cellar/node/22.18.0/bin/node", { exists: all, platform: "darwin", env: {} }),
    "/opt/homebrew/opt/node/bin/node",
  );
  assert.equal(
    stableExecPath("/home/linuxbrew/.linuxbrew/Cellar/node@22/22.18.0_1/bin/node", { exists: all, platform: "linux", env: {} }),
    "/home/linuxbrew/.linuxbrew/opt/node@22/bin/node",
  );
});

test("stableExecPath: fnm uses its default alias; nvm and n keep the exact binary", () => {
  const opts = { exists: all, platform: "linux", env: {} };
  assert.equal(
    stableExecPath("/Users/x/.local/share/fnm/node-versions/v22.18.0/installation/bin/node", opts),
    "/Users/x/.local/share/fnm/aliases/default/bin/node",
  );
  assert.equal(
    stableExecPath("/run/user/1/fnm_multishells/123_456/bin/node", { ...opts, env: { HOME: "/home/x" } }),
    "/home/x/.local/share/fnm/aliases/default/bin/node",
  );
  assert.equal(
    stableExecPath("/run/user/1/fnm_multishells/123_456/bin/node", { ...opts, platform: "darwin", env: { HOME: "/Users/x" } }),
    "/Users/x/Library/Application Support/fnm/aliases/default/bin/node",
  );
  assert.equal(
    stableExecPath("/x/fnmdir/node-versions/v22/installation/bin/node", { ...opts, env: { FNM_DIR: "/x/fnmdir" } }),
    "/x/fnmdir/aliases/default/bin/node",
  );
  // No default alias: keep the binary rather than rely on PATH.
  const fnmNode = "/Users/x/.local/share/fnm/node-versions/v22.18.0/installation/bin/node";
  assert.equal(stableExecPath(fnmNode, { ...opts, exists: none }), fnmNode);
  for (const p of ["/Users/x/.nvm/versions/node/v22.18.0/bin/node", "/usr/local/n/versions/node/22.18.0/bin/node"]) {
    assert.equal(stableExecPath(p, opts), p);
  }
  assert.equal(pinnedByManager("/Users/x/.nvm/versions/node/v22.18.0/bin/node", {}), "nvm");
  assert.equal(pinnedByManager("/x/nvmdir/versions/node/v22/bin/node", { NVM_DIR: "/x/nvmdir" }), "nvm");
  assert.equal(pinnedByManager("/usr/local/n/versions/node/22.18.0/bin/node", {}), "n");
  assert.equal(pinnedByManager(fnmNode, {}), "fnm");
  assert.equal(pinnedByManager("/usr/bin/node", {}), undefined);
});

test("stableExecPath: other managers' deno and bun use the same rules", () => {
  assert.equal(
    stableExecPath("/home/x/.local/share/mise/installs/bun/1.3.0/bin/bun", { exists: all, platform: "linux", env: {} }),
    "/home/x/.local/share/mise/shims/bun",
  );
});

test("stableExecPath: a missing shim keeps the exact binary", () => {
  for (const p of [
    "/Users/x/.local/share/mise/installs/node/22.18.0/bin/node",
    "/opt/homebrew/Cellar/node/22.18.0/bin/node",
    "/Users/x/.volta/tools/image/node/22.18.0/bin/node",
  ]) {
    assert.equal(stableExecPath(p, { exists: none, platform: "darwin", env: {} }), p);
  }
});

test("stableExecPath: system paths, Windows and --pin are unchanged", () => {
  const opts = { exists: all, platform: "linux", env: {} };
  assert.equal(stableExecPath("/usr/bin/node", opts), "/usr/bin/node");
  assert.equal(stableExecPath("/usr/local/bin/node", opts), "/usr/local/bin/node");
  const mise = "/Users/x/.local/share/mise/installs/node/22.18.0/bin/node";
  assert.equal(stableExecPath(mise, { ...opts, pin: true }), mise);
  const win = "C:\\Users\\x\\AppData\\Local\\mise\\installs\\node\\22\\node.exe";
  assert.equal(stableExecPath(win, { exists: all, platform: "win32", env: {} }), win);
});

test("jupyterDataDir: absolute even for a relative JUPYTER_DATA_DIR", () => {
  assert.equal(jupyterDataDir({ JUPYTER_DATA_DIR: "rel/data" }, "linux", "/h"), join(process.cwd(), "rel", "data"));
  assert.ok(isAbsolute(jupyterDataDir({ XDG_DATA_HOME: "xdg" }, "linux", "/h")));
});

test("jupyterDataDir: the parent of the kernels directory", () => {
  assert.equal(jupyterDataDir({ JUPYTER_DATA_DIR: "/d" }, "linux", "/h"), "/d");
  assert.equal(jupyterDataDir({}, "darwin", "/h"), join("/h", "Library", "Jupyter"));
  assert.equal(jupyterDataDir({ XDG_DATA_HOME: "/xdg" }, "linux", "/h"), join("/xdg", "jupyter"));
  assert.equal(jupyterDataDir({}, "linux", "/h"), join("/h", ".local", "share", "jupyter"));
});

// ---- the package copy

function tmp(t: { after(fn: () => void): void }): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cdpk-stable-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function pkg(dir: string, name: string, version: string, extra: Record<string, unknown> = {}, files: Record<string, string> = {}): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, main: "index.js", ...extra }));
  writeFileSync(join(dir, "index.js"), `module.exports = ${JSON.stringify(name + "@" + version)};`);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

const NAME = "@tlockney/cdp-kernel";
const mainFiles = { "dist/main.js": "// main\n" };

/** Resolves `from`'s dependency `name` the way Node does, returning its version-stamped export. */
function load(from: string, name: string): string {
  return createRequire(join(from, "index.js"))(name);
}

function resolvedIn(from: string, name: string, root: string): boolean {
  return createRequire(join(from, "index.js")).resolve(name).startsWith(root + sep);
}

/** Every symlink below `dir`, found with lstat so none is followed. */
function symlinksIn(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) found.push(path);
    else if (stat.isDirectory()) found.push(...symlinksIn(path));
  }
  return found;
}

function install(t: { after(fn: () => void): void }, entry: string, version = "1.0.0") {
  const data = tmp(t);
  const warnings: string[] = [];
  const result = stablePackage(entry, data, version, (m) => warnings.push(m));
  return { data, warnings, result };
}

test("copy: a global-style install (dependencies nested in the package)", (t) => {
  const src = tmp(t);
  const root = join(src, "lib", "node_modules", "@tlockney", "cdp-kernel");
  pkg(root, NAME, "1.0.0", { dependencies: { "dep-a": "1" } }, mainFiles);
  pkg(join(root, "node_modules", "dep-a"), "dep-a", "1.0.0", { dependencies: { "dep-b": "1" } });
  pkg(join(root, "node_modules", "dep-b"), "dep-b", "1.0.0");
  const { data, warnings, result } = install(t, join(root, "dist", "main.js"));
  assert.deepEqual(warnings, []);
  assert.ok(result?.copied);
  assert.equal(result.dest, join(data, "cdp-kernel", "1.0.0"));
  assert.equal(result.entry, join(result.dest, "dist", "main.js"));
  assert.ok(existsSync(result.entry));
  assert.equal(load(result.dest, "dep-a"), "dep-a@1.0.0");
  assert.equal(load(join(result.dest, "node_modules", "dep-a"), "dep-b"), "dep-b@1.0.0");
  assert.ok(existsSync(join(root, "node_modules", "dep-a")), "the original is left alone");
  assert.ok(!existsSync(`${result.dest}.${process.pid}.tmp`));
});

test("copy: a hoisted install pulls in the dependencies beside the package", (t) => {
  const src = tmp(t);
  const nm = join(src, "project", "node_modules");
  const root = pkg(join(nm, "@tlockney", "cdp-kernel"), NAME, "1.0.0", { dependencies: { "dep-a": "1", "@s/scoped": "1" } }, mainFiles);
  pkg(join(nm, "dep-a"), "dep-a", "1.0.0", { dependencies: { "dep-b": "1" } });
  pkg(join(nm, "dep-b"), "dep-b", "1.0.0");
  pkg(join(nm, "@s", "scoped"), "@s/scoped", "2.0.0");
  pkg(join(nm, "unrelated"), "unrelated", "1.0.0");
  const { warnings, result } = install(t, join(root, "dist", "main.js"));
  assert.deepEqual(warnings, []);
  assert.ok(result?.copied);
  for (const name of ["dep-a", "dep-b", "@s/scoped"]) {
    assert.ok(resolvedIn(result.dest, name, result.dest), `${name} resolves inside the copy`);
  }
  assert.ok(resolvedIn(join(result.dest, "node_modules", "dep-a"), "dep-b", result.dest));
  assert.ok(!existsSync(join(result.dest, "node_modules", "unrelated")));
});

test("copy: a symlinked (pnpm-style) layout is dereferenced", (t) => {
  const src = tmp(t);
  const store = join(src, "node_modules", ".pnpm");
  const real = pkg(join(store, "cdp@1", "node_modules", "@tlockney", "cdp-kernel"), NAME, "1.0.0", { dependencies: { "dep-a": "1" } }, mainFiles);
  pkg(join(store, "dep-a@1", "node_modules", "dep-a"), "dep-a", "1.0.0", { dependencies: { "dep-b": "1" } });
  pkg(join(store, "dep-b@1", "node_modules", "dep-b"), "dep-b", "1.0.0");
  symlinkSync(join(store, "dep-a@1", "node_modules", "dep-a"), join(store, "cdp@1", "node_modules", "dep-a"));
  symlinkSync(join(store, "dep-b@1", "node_modules", "dep-b"), join(store, "dep-a@1", "node_modules", "dep-b"));
  mkdirSync(join(src, "node_modules", "@tlockney"), { recursive: true });
  const link = join(src, "node_modules", "@tlockney", "cdp-kernel");
  symlinkSync(real, link);
  const { warnings, result } = install(t, join(link, "dist", "main.js"));
  assert.deepEqual(warnings, []);
  assert.ok(result?.copied);
  assert.ok(resolvedIn(result.dest, "dep-a", result.dest));
  assert.ok(resolvedIn(join(result.dest, "node_modules", "dep-a"), "dep-b", result.dest));
  assert.equal(load(join(result.dest, "node_modules", "dep-a"), "dep-b"), "dep-b@1.0.0");
  assert.deepEqual(symlinksIn(result.dest), [], "no symlink points back at the pnpm store");
});

test("copy: optional dependencies are copied when installed and skipped when not", (t) => {
  const src = tmp(t);
  const nm = join(src, "node_modules");
  const root = pkg(
    join(nm, "@tlockney", "cdp-kernel"),
    NAME,
    "1.0.0",
    { dependencies: { "dep-a": "1" }, optionalDependencies: { "native-here": "1", "native-elsewhere": "1" } },
    mainFiles,
  );
  pkg(join(nm, "dep-a"), "dep-a", "1.0.0", { optionalDependencies: { "@n/other-os": "1" } });
  pkg(join(nm, "native-here"), "native-here", "1.0.0");
  const { warnings, result } = install(t, join(root, "dist", "main.js"));
  assert.deepEqual(warnings, []);
  assert.ok(result?.copied);
  assert.ok(existsSync(join(result.dest, "node_modules", "native-here", "package.json")));
  assert.ok(!existsSync(join(result.dest, "node_modules", "native-elsewhere")));
  assert.ok(!existsSync(join(result.dest, "node_modules", "@n")));
});

test("copy: a version collision gives up and leaves the original in use", (t) => {
  const src = tmp(t);
  const nm = join(src, "node_modules");
  // The package has its own c@1; hoisted dep-a needs the c@2 beside it.
  const root = pkg(
    join(nm, "@tlockney", "cdp-kernel"),
    NAME,
    "1.0.0",
    { dependencies: { "dep-a": "1", c: "1" } },
    mainFiles,
  );
  pkg(join(root, "node_modules", "c"), "c", "1.0.0");
  pkg(join(nm, "dep-a"), "dep-a", "1.0.0", { dependencies: { c: "2" } });
  pkg(join(nm, "c"), "c", "2.0.0");
  const { data, warnings, result } = install(t, join(root, "dist", "main.js"));
  assert.equal(result, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /different version/);
  assert.match(warnings[0], /pointing the kernelspec at/);
  assert.ok(!existsSync(join(data, "cdp-kernel", "1.0.0")));
  assert.ok(!existsSync(join(data, "cdp-kernel", `1.0.0.${process.pid}.tmp`)), "staging is removed");
});

test("copy: a complete copy of the same version is kept; an incomplete one is replaced", (t) => {
  const src = tmp(t);
  const nm = join(src, "node_modules");
  const root = pkg(join(nm, "@tlockney", "cdp-kernel"), NAME, "1.0.0", { dependencies: { "dep-a": "1" } }, mainFiles);
  pkg(join(nm, "dep-a"), "dep-a", "1.0.0");
  const data = tmp(t);
  const first = stablePackage(join(root, "dist", "main.js"), data, "1.0.0");
  assert.ok(first?.copied);
  writeFileSync(join(first.dest, "marker"), "mine");
  const second = stablePackage(join(root, "dist", "main.js"), data, "1.0.0");
  assert.equal(second?.copied, false);
  assert.equal(second?.entry, first.entry);
  assert.ok(existsSync(join(first.dest, "marker")), "kept, not recopied");

  // A dependency is missing from the copy: copy again.
  rmSync(join(first.dest, "node_modules", "dep-a"), { recursive: true });
  const third = stablePackage(join(root, "dist", "main.js"), data, "1.0.0");
  assert.equal(third?.copied, true);
  assert.ok(!existsSync(join(first.dest, "marker")));
  assert.ok(existsSync(join(first.dest, "node_modules", "dep-a", "package.json")));
  assert.deepEqual(readdirSync(join(data, "cdp-kernel")), ["1.0.0"], "no staging or aside directory left");

  // An optional dependency installed in the source but missing from the
  // copy (made with --omit=optional, say): copy again.
  const opt = pkg(join(src, "opt", "node_modules", "@tlockney", "cdp-kernel"), NAME, "2.0.0", { optionalDependencies: { "opt-a": "1" } }, mainFiles);
  const optData = tmp(t);
  const bare = stablePackage(join(opt, "dist", "main.js"), optData, "2.0.0");
  assert.ok(bare?.copied);
  pkg(join(opt, "node_modules", "opt-a"), "opt-a", "1.0.0");
  const full = stablePackage(join(opt, "dist", "main.js"), optData, "2.0.0");
  assert.equal(full?.copied, true);
  assert.ok(existsSync(join(full.dest, "node_modules", "opt-a", "package.json")));

  // A different version gets its own directory and leaves this one.
  const next = stablePackage(join(root, "dist", "main.js"), data, "1.1.0");
  assert.equal(next?.copied, true);
  assert.ok(existsSync(join(data, "cdp-kernel", "1.0.0")));
});

test("copy: nested symlinks (node_modules/.bin) are replaced by copies", (t) => {
  const src = tmp(t);
  const nm = join(src, "node_modules");
  const root = pkg(join(nm, "@tlockney", "cdp-kernel"), NAME, "1.0.0", { dependencies: { "dep-a": "1" } }, mainFiles);
  pkg(join(root, "node_modules", "dep-a"), "dep-a", "1.0.0", {}, { "bin/cli.js": "// cli\n" });
  mkdirSync(join(root, "node_modules", ".bin"));
  symlinkSync(join(root, "node_modules", "dep-a", "bin", "cli.js"), join(root, "node_modules", ".bin", "cli"));
  symlinkSync("../does-not-exist", join(root, "node_modules", ".bin", "dangling"));
  const { warnings, result } = install(t, join(root, "dist", "main.js"));
  assert.deepEqual(warnings, []);
  assert.ok(result?.copied);
  assert.deepEqual(symlinksIn(result.dest), []);
  assert.equal(readFileSync(join(result.dest, "node_modules", ".bin", "cli"), "utf8"), "// cli\n");
  assert.ok(!existsSync(join(result.dest, "node_modules", ".bin", "dangling")));
});

test("copy: no package.json for this package above the file falls back", (t) => {
  const src = tmp(t);
  mkdirSync(join(src, "node_modules", "x"), { recursive: true });
  writeFileSync(join(src, "node_modules", "x", "main.js"), "");
  const { warnings, result } = install(t, join(src, "node_modules", "x", "main.js"));
  assert.equal(result, undefined);
  assert.match(warnings[0], /can't find/);
});

test("stableOrigin: a checkout or JSR install is unchanged; node_modules is copied", (t) => {
  const data = tmp(t);
  const checkout = { kind: "file", path: "/work/cdp-kernel/src/main.ts" } as const;
  assert.deepEqual(stableOrigin(checkout, "file:///work/cdp-kernel/src/main.ts", data, "1.0.0"), { origin: checkout });
  const jsr = { kind: "jsr", specifier: "jsr:@tlockney/cdp-kernel@1.0.0/cli" } as const;
  assert.deepEqual(stableOrigin(jsr, "https://jsr.io/@tlockney/cdp-kernel/1.0.0/src/main.ts", data, "1.0.0"), { origin: jsr });
  assert.ok(!existsSync(join(data, "cdp-kernel")));

  const src = tmp(t);
  const root = pkg(join(src, "node_modules", "@tlockney", "cdp-kernel"), NAME, "1.0.0", {}, mainFiles);
  const entry = join(root, "dist", "main.js");
  const r = stableOrigin({ kind: "file", path: entry }, `file://${entry}`, data, "1.0.0");
  assert.deepEqual(r.origin, { kind: "file", path: join(data, "cdp-kernel", "1.0.0", "dist", "main.js") });
  assert.ok(r.copy?.copied);
});

// ---- pruning

test("prune: removes only unreferenced version directories", (t) => {
  const data = tmp(t);
  const root = join(data, "cdp-kernel");
  const live = `0.12.2.${process.pid}.tmp`;
  // No process has this pid (above Linux's and macOS's pid limits).
  const deadTmp = "0.12.2.2147483646.tmp";
  const deadOld = "0.12.2.old.2147483646";
  for (const d of ["0.11.0", "0.12.0", "0.12.1-rc.1", "notes", live, deadTmp, deadOld]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "0.9.0"), "a file, not a directory");
  const argvs = [
    ["node", join(root, "0.12.0", "dist", "main.js"), "kernel", "--conn", "{connection_file}"],
    ["deno", "run", join(root, "0.12.1-rc.1", "dist", "main.js")],
  ];
  const removed = pruneStableCopies(data, argvs);
  assert.deepEqual(removed.sort(), [join(root, "0.11.0"), join(root, deadTmp), join(root, deadOld)].sort());
  for (const kept of ["0.12.0", "0.12.1-rc.1", "notes", live, "0.9.0"]) assert.ok(existsSync(join(root, kept)), kept);
  // A path that only shares a prefix doesn't count as a reference.
  assert.deepEqual(pruneStableCopies(data, [["node", join(root, "0.12.00", "x")]]).sort(), [join(root, "0.12.0"), join(root, "0.12.1-rc.1")].sort());
});

test("prune: only absolute argv entries count as references", (t) => {
  const data = tmp(t);
  const root = join(data, "cdp-kernel");
  mkdirSync(join(root, "0.3.0"), { recursive: true });
  const rel = join("cdp-kernel", "0.3.0", "dist", "main.js");
  const saved = process.cwd();
  process.chdir(data);
  try {
    assert.deepEqual(pruneStableCopies(data, [["node", rel]]), [join(root, "0.3.0")]);
  } finally {
    process.chdir(saved);
  }
});

test("prune: nothing to do without a stable root", (t) => {
  assert.deepEqual(pruneStableCopies(tmp(t), []), []);
});
