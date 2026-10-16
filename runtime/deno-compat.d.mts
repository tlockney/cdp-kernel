export class NotFound extends Error {
  code?: string;
}
export class AlreadyExists extends Error {
  code?: string;
}
export class PermissionDenied extends Error {
  code?: string;
}
export class IsADirectory extends Error {
  code?: string;
}
export class NotADirectory extends Error {
  code?: string;
}

export interface DenoErrors {
  NotFound: typeof NotFound;
  AlreadyExists: typeof AlreadyExists;
  PermissionDenied: typeof PermissionDenied;
  IsADirectory: typeof IsADirectory;
  NotADirectory: typeof NotADirectory;
}

export interface FileInfo {
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mtime: Date | null;
  atime: Date | null;
  birthtime: Date | null;
  mode: number;
  uid: number;
  gid: number;
}

export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

export type PathLike = string | URL;

export interface WriteFileOptions {
  append?: boolean;
  createNew?: boolean;
}

export interface MakeTempOptions {
  dir?: string;
  prefix?: string;
  suffix?: string;
}

export interface DenoEnv {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
  has(key: string): boolean;
  toObject(): Record<string, string | undefined>;
}

export interface DenoWriter {
  write(bytes: Uint8Array): Promise<number>;
  writeSync(bytes: Uint8Array): number;
}

export interface DenoShim {
  jupyter: unknown;
  version: { deno: string; v8: string; typescript: string };
  build: { os: string; arch: string; target: string };
  errors: DenoErrors;
  pid: number;
  args: string[];
  noColor: boolean;
  execPath: () => string;
  cwd: () => string;
  chdir: (dir: PathLike) => void;
  exit: (code?: number) => never;
  env: DenoEnv;
  inspect: (value: unknown, options?: object) => string;

  readTextFile: (path: PathLike) => Promise<string>;
  readTextFileSync: (path: PathLike) => string;
  readFile: (path: PathLike) => Promise<Uint8Array>;
  readFileSync: (path: PathLike) => Uint8Array;
  writeTextFile: (path: PathLike, data: string, options?: WriteFileOptions) => Promise<void>;
  writeTextFileSync: (path: PathLike, data: string, options?: WriteFileOptions) => void;
  writeFile: (path: PathLike, data: Uint8Array | string, options?: WriteFileOptions) => Promise<void>;
  writeFileSync: (path: PathLike, data: Uint8Array | string, options?: WriteFileOptions) => void;
  readDir: (path: PathLike) => AsyncIterable<DirEntry>;
  readDirSync: (path: PathLike) => DirEntry[];
  stat: (path: PathLike) => Promise<FileInfo>;
  statSync: (path: PathLike) => FileInfo;
  lstat: (path: PathLike) => Promise<FileInfo>;
  lstatSync: (path: PathLike) => FileInfo;
  mkdir: (path: PathLike, options?: { recursive?: boolean }) => Promise<void>;
  mkdirSync: (path: PathLike, options?: { recursive?: boolean }) => void;
  remove: (path: PathLike, options?: { recursive?: boolean }) => Promise<void>;
  removeSync: (path: PathLike, options?: { recursive?: boolean }) => void;
  rename: (from: PathLike, to: PathLike) => Promise<void>;
  renameSync: (from: PathLike, to: PathLike) => void;
  realPath: (path: PathLike) => Promise<string>;
  realPathSync: (path: PathLike) => string;
  makeTempDir: (options?: MakeTempOptions) => Promise<string>;
  makeTempDirSync: (options?: MakeTempOptions) => string;
  makeTempFile: (options?: MakeTempOptions) => Promise<string>;
  stdout: DenoWriter;
  stderr: DenoWriter;
}

export function denoError<E>(err: E): E | NotFound | AlreadyExists | PermissionDenied | IsADirectory | NotADirectory;
export function createDenoShim(options: { jupyter: unknown }): DenoShim;
/** Adds the cause to "Deno.x is not a function" when `shim` lacks `x`. */
export function explainMissing(message: string, shim: object): string;
