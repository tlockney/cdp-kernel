import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDenoShim, denoError, type DenoShim } from "../runtime/deno-compat.mjs";

function setup(t: TestContext): { deno: DenoShim; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deno-compat-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { deno: createDenoShim({ jupyter: {} }), dir };
}

function errnoError(code: string): Error & { code: string } {
  return Object.assign(new Error(`boom ${code}`), { code });
}

test("jupyter is passed through by identity", () => {
  const jupyter = { marker: true };
  assert.equal(createDenoShim({ jupyter }).jupyter, jupyter);
});

test("build maps os and arch for the current platform", () => {
  const { build } = createDenoShim({ jupyter: null });
  const osNames: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows", freebsd: "freebsd" };
  const archNames: Record<string, string> = { arm64: "aarch64", x64: "x86_64" };
  assert.equal(build.os, osNames[process.platform] ?? process.platform);
  assert.equal(build.arch, archNames[process.arch] ?? process.arch);
  assert.ok(build.target.includes(build.arch));
});

test("env get/set/has/delete/toObject", (t) => {
  const { deno } = setup(t);
  const key = `DENO_COMPAT_TEST_${process.pid}_${Date.now()}`;
  t.after(() => {
    delete process.env[key];
  });
  assert.equal(deno.env.has(key), false);
  assert.equal(deno.env.get(key), undefined);
  deno.env.set(key, "value");
  assert.equal(deno.env.get(key), "value");
  assert.equal(deno.env.has(key), true);
  assert.equal(deno.env.toObject()[key], "value");
  deno.env.delete(key);
  assert.equal(deno.env.has(key), false);
  assert.equal(deno.env.toObject()[key], undefined);
});

test("cwd matches process.cwd and process-level members exist", (t) => {
  const { deno } = setup(t);
  assert.equal(deno.cwd(), process.cwd());
  assert.equal(deno.execPath(), process.execPath);
  assert.equal(deno.pid, process.pid);
  assert.equal(typeof deno.chdir, "function");
  assert.equal(typeof deno.exit, "function");
  assert.equal(typeof deno.stdout.write, "function");
  assert.equal(typeof deno.stdout.writeSync, "function");
  assert.equal(typeof deno.stderr.write, "function");
  assert.equal(typeof deno.stderr.writeSync, "function");
});

test("readTextFile/writeTextFile round-trip, async and sync", async (t) => {
  const { deno, dir } = setup(t);
  const file = path.join(dir, "a.txt");
  await deno.writeTextFile(file, "héllo");
  assert.equal(await deno.readTextFile(file), "héllo");
  deno.writeTextFileSync(file, "sync");
  assert.equal(deno.readTextFileSync(file), "sync");
});

test("writeTextFile append option appends", async (t) => {
  const { deno, dir } = setup(t);
  const file = path.join(dir, "a.txt");
  await deno.writeTextFile(file, "one");
  await deno.writeTextFile(file, "two", { append: true });
  assert.equal(await deno.readTextFile(file), "onetwo");
  deno.writeTextFileSync(file, "three", { append: true });
  assert.equal(deno.readTextFileSync(file), "onetwothree");
});

test("writeTextFile createNew throws AlreadyExists on an existing file", async (t) => {
  const { deno, dir } = setup(t);
  const file = path.join(dir, "a.txt");
  await deno.writeTextFile(file, "x", { createNew: true });
  await assert.rejects(deno.writeTextFile(file, "y", { createNew: true }), (err: unknown) => {
    assert.ok(err instanceof deno.errors.AlreadyExists);
    assert.equal((err as { code?: string }).code, "EEXIST");
    return true;
  });
  assert.throws(() => deno.writeTextFileSync(file, "y", { createNew: true }), deno.errors.AlreadyExists);
  assert.equal(deno.readTextFileSync(file), "x");
});

test("writeFile/readFile round-trip bytes and return a plain Uint8Array", async (t) => {
  const { deno, dir } = setup(t);
  const file = path.join(dir, "b.bin");
  const bytes = new Uint8Array([0, 1, 2, 255]);
  await deno.writeFile(file, bytes);
  const read = await deno.readFile(file);
  assert.equal(Object.getPrototypeOf(read), Uint8Array.prototype);
  assert.deepEqual([...read], [0, 1, 2, 255]);
  deno.writeFileSync(file, new Uint8Array([9, 8]));
  const readSync = deno.readFileSync(file);
  assert.equal(Object.getPrototypeOf(readSync), Uint8Array.prototype);
  assert.deepEqual([...readSync], [9, 8]);
});

test("reading a missing file throws NotFound with code ENOENT, async and sync", async (t) => {
  const { deno, dir } = setup(t);
  const file = path.join(dir, "missing.txt");
  const check = (err: unknown): boolean => {
    assert.ok(err instanceof deno.errors.NotFound);
    assert.equal(err.name, "NotFound");
    assert.equal((err as { code?: string }).code, "ENOENT");
    assert.ok(err.cause instanceof Error);
    return true;
  };
  await assert.rejects(deno.readTextFile(file), check);
  await assert.rejects(deno.readFile(file), check);
  assert.throws(() => deno.readTextFileSync(file), check);
  assert.throws(() => deno.readFileSync(file), check);
});

test("readDir and readDirSync report entry kinds", async (t) => {
  const { deno, dir } = setup(t);
  fs.writeFileSync(path.join(dir, "f.txt"), "x");
  fs.mkdirSync(path.join(dir, "sub"));

  const fromAsync: Record<string, { isFile: boolean; isDirectory: boolean }> = {};
  for await (const entry of deno.readDir(dir)) {
    fromAsync[entry.name] = { isFile: entry.isFile, isDirectory: entry.isDirectory };
  }
  assert.deepEqual(fromAsync, {
    "f.txt": { isFile: true, isDirectory: false },
    sub: { isFile: false, isDirectory: true },
  });

  const entries = deno.readDirSync(dir).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(entries.map((e) => e.name), ["f.txt", "sub"]);
  assert.equal(entries[0]?.isFile, true);
  assert.equal(entries[0]?.isSymlink, false);
  assert.equal(entries[1]?.isDirectory, true);
});

test("readDir on a missing directory throws NotFound", async (t) => {
  const { deno, dir } = setup(t);
  const missing = path.join(dir, "nope");
  await assert.rejects(async () => {
    for await (const _ of deno.readDir(missing)) void _;
  }, deno.errors.NotFound);
  assert.throws(() => deno.readDirSync(missing), deno.errors.NotFound);
});

test("stat and lstat report file and directory info", async (t) => {
  const { deno, dir } = setup(t);
  const file = path.join(dir, "f.txt");
  fs.writeFileSync(file, "12345");

  for (const info of [await deno.stat(file), deno.statSync(file), await deno.lstat(file), deno.lstatSync(file)]) {
    assert.equal(info.isFile, true);
    assert.equal(info.isDirectory, false);
    assert.equal(info.isSymlink, false);
    assert.equal(info.size, 5);
    assert.ok(info.mtime instanceof Date);
  }
  assert.equal((await deno.stat(dir)).isDirectory, true);
  assert.equal(deno.lstatSync(dir).isFile, false);
});

test("lstat sees a symlink while stat follows it", async (t) => {
  const { deno, dir } = setup(t);
  const file = path.join(dir, "f.txt");
  const link = path.join(dir, "link");
  fs.writeFileSync(file, "x");
  fs.symlinkSync(file, link);
  assert.equal((await deno.lstat(link)).isSymlink, true);
  assert.equal(deno.statSync(link).isSymlink, false);
  assert.equal(deno.statSync(link).isFile, true);
});

test("stat on a missing path throws NotFound", async (t) => {
  const { deno, dir } = setup(t);
  const missing = path.join(dir, "nope");
  await assert.rejects(deno.stat(missing), deno.errors.NotFound);
  assert.throws(() => deno.lstatSync(missing), deno.errors.NotFound);
});

test("mkdir recursive creates nested directories; non-recursive fails without parents", async (t) => {
  const { deno, dir } = setup(t);
  const nested = path.join(dir, "a", "b", "c");
  await deno.mkdir(nested, { recursive: true });
  assert.ok(fs.statSync(nested).isDirectory());
  const nestedSync = path.join(dir, "x", "y");
  deno.mkdirSync(nestedSync, { recursive: true });
  assert.ok(fs.statSync(nestedSync).isDirectory());

  await assert.rejects(deno.mkdir(path.join(dir, "p", "q")), deno.errors.NotFound);
  await assert.rejects(deno.mkdir(nested), deno.errors.AlreadyExists);
  assert.throws(() => deno.mkdirSync(nestedSync), deno.errors.AlreadyExists);
});

test("remove recursive deletes a tree; non-recursive refuses a populated directory", async (t) => {
  const { deno, dir } = setup(t);
  const tree = path.join(dir, "tree");
  fs.mkdirSync(path.join(tree, "inner"), { recursive: true });
  fs.writeFileSync(path.join(tree, "inner", "f.txt"), "x");
  await assert.rejects(deno.remove(tree));
  await deno.remove(tree, { recursive: true });
  assert.equal(fs.existsSync(tree), false);

  const tree2 = path.join(dir, "tree2");
  fs.mkdirSync(path.join(tree2, "inner"), { recursive: true });
  deno.removeSync(tree2, { recursive: true });
  assert.equal(fs.existsSync(tree2), false);

  await assert.rejects(deno.remove(path.join(dir, "nope")), deno.errors.NotFound);
});

test("rename moves files, async and sync", async (t) => {
  const { deno, dir } = setup(t);
  const a = path.join(dir, "a.txt");
  const b = path.join(dir, "b.txt");
  const c = path.join(dir, "c.txt");
  fs.writeFileSync(a, "x");
  await deno.rename(a, b);
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.readFileSync(b, "utf8"), "x");
  deno.renameSync(b, c);
  assert.equal(fs.existsSync(b), false);
  assert.equal(fs.readFileSync(c, "utf8"), "x");
  await assert.rejects(deno.rename(a, b), deno.errors.NotFound);
});

test("realPath resolves symlinks, async and sync", async (t) => {
  const { deno, dir } = setup(t);
  const file = path.join(dir, "f.txt");
  const link = path.join(dir, "link");
  fs.writeFileSync(file, "x");
  fs.symlinkSync(file, link);
  // The native call expands Windows 8.3 names (RUNNER~1), as Deno.realPath does (#32).
  const expected = fs.realpathSync.native(file);
  assert.equal(await deno.realPath(link), expected);
  assert.equal(deno.realPathSync(link), expected);
});

test("makeTempDir honours dir and prefix", async (t) => {
  const { deno, dir } = setup(t);
  const made = await deno.makeTempDir({ dir, prefix: "pre-" });
  assert.equal(path.dirname(made), dir);
  assert.ok(path.basename(made).startsWith("pre-"));
  assert.ok(fs.statSync(made).isDirectory());
  const madeSync = deno.makeTempDirSync({ dir, prefix: "sync-" });
  assert.ok(path.basename(madeSync).startsWith("sync-"));
  assert.ok(fs.statSync(madeSync).isDirectory());
});

test("makeTempFile honours dir, prefix and suffix and creates the file", async (t) => {
  const { deno, dir } = setup(t);
  const file = await deno.makeTempFile({ dir, prefix: "pre-", suffix: ".txt" });
  assert.ok(file.startsWith(dir));
  assert.ok(path.basename(file).startsWith("pre-"));
  assert.ok(file.endsWith(".txt"));
  assert.ok(fs.statSync(file).isFile());
  assert.equal(fs.readFileSync(file, "utf8"), "");
});

test("inspect returns a string", (t) => {
  const { deno } = setup(t);
  assert.equal(typeof deno.inspect({ a: 1 }), "string");
  assert.equal(deno.inspect({ a: 1 }), "{ a: 1 }");
});

test("denoError returns non-errno errors unchanged", () => {
  const plain = new Error("plain");
  assert.equal(denoError(plain), plain);
  const unknownCode = errnoError("EWHATEVER");
  assert.equal(denoError(unknownCode), unknownCode);
});

test("denoError maps errno codes to Deno error classes preserving code and cause", () => {
  const deno = createDenoShim({ jupyter: null });
  const cases: [string, keyof typeof deno.errors][] = [
    ["ENOENT", "NotFound"],
    ["EEXIST", "AlreadyExists"],
    ["EACCES", "PermissionDenied"],
    ["EPERM", "PermissionDenied"],
    ["EISDIR", "IsADirectory"],
    ["ENOTDIR", "NotADirectory"],
  ];
  for (const [code, className] of cases) {
    const original = errnoError(code);
    const mapped = denoError(original);
    assert.ok(mapped instanceof deno.errors[className], `${code} -> ${className}`);
    assert.equal(mapped.name, className);
    assert.equal(mapped.message, original.message);
    assert.equal((mapped as { code?: string }).code, code);
    assert.equal(mapped.cause, original);
  }
});

test("reading a directory as a file throws IsADirectory", (t) => {
  const { deno, dir } = setup(t);
  assert.throws(() => deno.readTextFileSync(dir), deno.errors.IsADirectory);
});
