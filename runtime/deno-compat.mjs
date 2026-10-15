// @ts-self-types="./deno-compat.d.mts"
// An opt-in `Deno` namespace for Node targets, so notebooks written for
// `deno jupyter` keep working: Deno.jupyter plus the file, env and process
// APIs notebooks commonly reach for, implemented on Node's.
//
// Opt-in because libraries feature-detect Deno with `typeof Deno`; with a
// shim installed they take their Deno code paths, which may call APIs not
// covered here (Deno.serve, Deno.Command, Deno.openKv, permissions...).
// Uncovered APIs are simply absent rather than throwing on access, so
// feature checks like `typeof Deno.serve === "function"` still work.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import util from "node:util";

class NotFound extends Error {
  name = "NotFound";
}
class AlreadyExists extends Error {
  name = "AlreadyExists";
}
class PermissionDenied extends Error {
  name = "PermissionDenied";
}
class IsADirectory extends Error {
  name = "IsADirectory";
}
class NotADirectory extends Error {
  name = "NotADirectory";
}

const ERRNO_TO_ERROR = {
  ENOENT: NotFound,
  EEXIST: AlreadyExists,
  EACCES: PermissionDenied,
  EPERM: PermissionDenied,
  EISDIR: IsADirectory,
  ENOTDIR: NotADirectory,
};

/** Rethrows Node fs errors as the Deno.errors class Deno would use. */
export function denoError(err) {
  const Ctor = err && ERRNO_TO_ERROR[err.code];
  if (!Ctor) return err;
  const mapped = new Ctor(err.message, { cause: err });
  mapped.code = err.code;
  return mapped;
}

function sync(fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      throw denoError(err);
    }
  };
}

function async(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      throw denoError(err);
    }
  };
}

const toPath = (p) => (p instanceof URL ? p : String(p));

function fileInfo(stats) {
  return {
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    isSymlink: stats.isSymbolicLink(),
    size: stats.size,
    mtime: stats.mtime,
    atime: stats.atime,
    birthtime: stats.birthtime,
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
  };
}

function dirEntry(dirent) {
  return {
    name: dirent.name,
    isFile: dirent.isFile(),
    isDirectory: dirent.isDirectory(),
    isSymlink: dirent.isSymbolicLink(),
  };
}

const writeFlag = (options) => (options?.append ? "a" : options?.createNew ? "wx" : "w");

const OS_NAMES = { darwin: "darwin", linux: "linux", win32: "windows", freebsd: "freebsd" };
const ARCH_NAMES = { arm64: "aarch64", x64: "x86_64" };

export function createDenoShim({ jupyter }) {
  return {
    jupyter,
    version: { deno: "0.0.0-cdp-kernel", v8: process.versions.v8, typescript: "5" },
    build: {
      os: OS_NAMES[process.platform] ?? process.platform,
      arch: ARCH_NAMES[process.arch] ?? process.arch,
      target: `${ARCH_NAMES[process.arch] ?? process.arch}-node-${process.platform}`,
    },
    errors: { NotFound, AlreadyExists, PermissionDenied, IsADirectory, NotADirectory },
    pid: process.pid,
    args: process.argv.slice(2),
    noColor: Boolean(process.env.NO_COLOR),
    execPath: () => process.execPath,
    cwd: () => process.cwd(),
    chdir: sync((dir) => process.chdir(toPath(dir))),
    exit: (code) => process.exit(code),
    env: {
      get: (key) => process.env[key],
      set: (key, value) => {
        process.env[key] = value;
      },
      delete: (key) => {
        delete process.env[key];
      },
      has: (key) => Object.hasOwn(process.env, key),
      toObject: () => ({ ...process.env }),
    },
    inspect: (value, options) => util.inspect(value, options),

    readTextFile: async((p) => fsp.readFile(toPath(p), "utf8")),
    readTextFileSync: sync((p) => fs.readFileSync(toPath(p), "utf8")),
    readFile: async(async (p) => new Uint8Array(await fsp.readFile(toPath(p)))),
    readFileSync: sync((p) => new Uint8Array(fs.readFileSync(toPath(p)))),
    writeTextFile: async((p, data, options) => fsp.writeFile(toPath(p), data, { flag: writeFlag(options) })),
    writeTextFileSync: sync((p, data, options) => fs.writeFileSync(toPath(p), data, { flag: writeFlag(options) })),
    writeFile: async((p, data, options) => fsp.writeFile(toPath(p), data, { flag: writeFlag(options) })),
    writeFileSync: sync((p, data, options) => fs.writeFileSync(toPath(p), data, { flag: writeFlag(options) })),
    async *readDir(p) {
      let entries;
      try {
        entries = await fsp.readdir(toPath(p), { withFileTypes: true });
      } catch (err) {
        throw denoError(err);
      }
      for (const entry of entries) yield dirEntry(entry);
    },
    readDirSync: sync((p) => fs.readdirSync(toPath(p), { withFileTypes: true }).map(dirEntry)),
    stat: async(async (p) => fileInfo(await fsp.stat(toPath(p)))),
    statSync: sync((p) => fileInfo(fs.statSync(toPath(p)))),
    lstat: async(async (p) => fileInfo(await fsp.lstat(toPath(p)))),
    lstatSync: sync((p) => fileInfo(fs.lstatSync(toPath(p)))),
    mkdir: async((p, options) => fsp.mkdir(toPath(p), { recursive: options?.recursive ?? false }).then(() => {})),
    mkdirSync: sync((p, options) => {
      fs.mkdirSync(toPath(p), { recursive: options?.recursive ?? false });
    }),
    remove: async((p, options) => fsp.rm(toPath(p), { recursive: options?.recursive ?? false })),
    removeSync: sync((p, options) => fs.rmSync(toPath(p), { recursive: options?.recursive ?? false })),
    rename: async((from, to) => fsp.rename(toPath(from), toPath(to))),
    renameSync: sync((from, to) => fs.renameSync(toPath(from), toPath(to))),
    realPath: async((p) => fsp.realpath(toPath(p))),
    realPathSync: sync((p) => fs.realpathSync(toPath(p))),
    makeTempDir: async((options) =>
      fsp.mkdtemp(path.join(options?.dir ?? os.tmpdir(), options?.prefix ?? "deno-"))
    ),
    makeTempDirSync: sync((options) =>
      fs.mkdtempSync(path.join(options?.dir ?? os.tmpdir(), options?.prefix ?? "deno-"))
    ),
    makeTempFile: async(async (options) => {
      const dir = await fsp.mkdtemp(path.join(options?.dir ?? os.tmpdir(), "deno-"));
      const file = path.join(dir, `${options?.prefix ?? ""}tmp${options?.suffix ?? ""}`);
      await fsp.writeFile(file, "");
      return file;
    }),
    stdout: {
      write: (bytes) => new Promise((resolve) => process.stdout.write(bytes, () => resolve(bytes.length))),
      writeSync: (bytes) => (process.stdout.write(bytes), bytes.length),
    },
    stderr: {
      write: (bytes) => new Promise((resolve) => process.stderr.write(bytes, () => resolve(bytes.length))),
      writeSync: (bytes) => (process.stderr.write(bytes), bytes.length),
    },
  };
}
