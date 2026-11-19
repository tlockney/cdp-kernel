// Declarations for what cells in the browser Worker can use, for the
// language service (#524): the globals a Worker has that cells reach for
// (console, timers, fetch and the types it takes and returns, URL, text
// encoding, abort signals), in place of lib.webworker.d.ts (787 KB) or
// lib.dom.d.ts (2.3 MB), which the page would have to serve and TypeScript
// parse for the few names a cell uses. A global not listed here is an error
// in a cell's diagnostics although the Worker has it; say so in an issue
// and add it. No imports: this is a script file, so these are global.

export const BROWSER_GLOBALS = `
interface ImportMeta {
  url: string;
  resolve(specifier: string): string;
}
interface Console {
  assert(condition?: boolean, ...data: any[]): void;
  clear(): void;
  count(label?: string): void;
  countReset(label?: string): void;
  debug(...data: any[]): void;
  dir(item?: any, options?: any): void;
  dirxml(...data: any[]): void;
  error(...data: any[]): void;
  group(...data: any[]): void;
  groupCollapsed(...data: any[]): void;
  groupEnd(): void;
  info(...data: any[]): void;
  log(...data: any[]): void;
  table(tabularData?: any, properties?: string[]): void;
  time(label?: string): void;
  timeEnd(label?: string): void;
  timeLog(label?: string, ...data: any[]): void;
  trace(...data: any[]): void;
  warn(...data: any[]): void;
}
declare var console: Console;
declare var self: typeof globalThis;
declare function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): number;
declare function clearTimeout(id: number | undefined): void;
declare function setInterval(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): number;
declare function clearInterval(id: number | undefined): void;
declare function queueMicrotask(callback: () => void): void;
declare function structuredClone<T = any>(value: T, options?: { transfer?: any[] }): T;
declare function atob(data: string): string;
declare function btoa(data: string): string;
declare var performance: { now(): number; readonly timeOrigin: number; mark(name: string): unknown; measure(name: string, start?: string, end?: string): unknown };
declare var crypto: { randomUUID(): string; getRandomValues<T extends ArrayBufferView | null>(array: T): T; readonly subtle: any };


// What a Worker has that is big to type in full: loosely typed, so using
// it is no error, and what it returns is mostly \`any\`.
declare var WebAssembly: any;
declare var navigator: {
  readonly userAgent: string;
  readonly language: string;
  readonly languages: readonly string[];
  readonly hardwareConcurrency: number;
  readonly onLine: boolean;
  readonly platform: string;
  readonly [key: string]: any;
};
declare var location: any;
declare var indexedDB: any;
declare var caches: any;
declare var origin: string;
declare function postMessage(message: any, transfer?: any): void;
declare function reportError(error: any): void;
interface Event { readonly type: string; readonly target: any; readonly defaultPrevented: boolean; preventDefault(): void; stopPropagation(): void; readonly [key: string]: any }
declare var Event: { prototype: Event; new(type: string, init?: any): Event };
interface CustomEvent<T = any> extends Event { readonly detail: T }
declare var CustomEvent: { prototype: CustomEvent; new<T = any>(type: string, init?: { detail?: T }): CustomEvent<T> };
interface ReadableStream<R = any> {
  readonly locked: boolean;
  cancel(reason?: any): Promise<void>;
  getReader(options?: any): any;
  pipeThrough(transform: any, options?: any): ReadableStream;
  pipeTo(destination: any, options?: any): Promise<void>;
  tee(): [ReadableStream<R>, ReadableStream<R>];
  values(options?: any): AsyncIterableIterator<R>;
  [Symbol.asyncIterator](): AsyncIterableIterator<R>;
}
declare var ReadableStream: { prototype: ReadableStream; new<R = any>(source?: any, strategy?: any): ReadableStream<R>; from<R>(iterable: Iterable<R> | AsyncIterable<R>): ReadableStream<R> };
interface WritableStream<W = any> { readonly locked: boolean; abort(reason?: any): Promise<void>; close(): Promise<void>; getWriter(): any }
declare var WritableStream: { prototype: WritableStream; new<W = any>(sink?: any, strategy?: any): WritableStream<W> };
interface TransformStream<I = any, O = any> { readonly readable: ReadableStream<O>; readonly writable: WritableStream<I> }
declare var TransformStream: { prototype: TransformStream; new<I = any, O = any>(transformer?: any, writable?: any, readable?: any): TransformStream<I, O> };
interface FormData {
  append(name: string, value: string | Blob, fileName?: string): void;
  delete(name: string): void;
  get(name: string): any;
  getAll(name: string): any[];
  has(name: string): boolean;
  set(name: string, value: string | Blob, fileName?: string): void;
  forEach(callback: (value: any, key: string, parent: FormData) => void): void;
  entries(): IterableIterator<[string, any]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<any>;
  [Symbol.iterator](): IterableIterator<[string, any]>;
}
declare var FormData: { prototype: FormData; new(): FormData };
interface File extends Blob { readonly name: string; readonly lastModified: number }
declare var File: { prototype: File; new(bits: (BufferSource | Blob | string)[], name: string, options?: { type?: string; lastModified?: number }): File };
interface MessagePort extends EventTarget {
  postMessage(message: any, transfer?: any): void;
  start(): void;
  close(): void;
  onmessage: ((event: any) => void) | null;
}
declare var MessagePort: { prototype: MessagePort };
interface MessageChannel { readonly port1: MessagePort; readonly port2: MessagePort }
declare var MessageChannel: { prototype: MessageChannel; new(): MessageChannel };
interface BroadcastChannel extends EventTarget { readonly name: string; postMessage(message: any): void; close(): void; onmessage: ((event: any) => void) | null }
declare var BroadcastChannel: { prototype: BroadcastChannel; new(name: string): BroadcastChannel };
interface WebSocket extends EventTarget {
  readonly url: string;
  readonly readyState: number;
  binaryType: string;
  send(data: string | BufferSource | Blob): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
}
declare var WebSocket: {
  prototype: WebSocket;
  new(url: string | URL, protocols?: string | string[]): WebSocket;
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
};
interface Worker extends EventTarget { postMessage(message: any, transfer?: any): void; terminate(): void; onmessage: ((event: any) => void) | null; onerror: ((event: any) => void) | null }
declare var Worker: { prototype: Worker; new(url: string | URL, options?: { type?: "classic" | "module"; name?: string }): Worker };

interface EventTarget {
  addEventListener(type: string, listener: ((event: any) => void) | null, options?: boolean | { once?: boolean; signal?: AbortSignal }): void;
  removeEventListener(type: string, listener: ((event: any) => void) | null): void;
}
interface AbortSignal extends EventTarget {
  readonly aborted: boolean;
  readonly reason: any;
  onabort: ((event: any) => void) | null;
  throwIfAborted(): void;
}
declare var AbortSignal: {
  prototype: AbortSignal;
  abort(reason?: any): AbortSignal;
  timeout(milliseconds: number): AbortSignal;
  any(signals: AbortSignal[]): AbortSignal;
};
interface AbortController {
  readonly signal: AbortSignal;
  abort(reason?: any): void;
}
declare var AbortController: { prototype: AbortController; new(): AbortController };

interface TextEncoder {
  readonly encoding: string;
  encode(input?: string): Uint8Array;
}
declare var TextEncoder: { prototype: TextEncoder; new(): TextEncoder };
interface TextDecoder {
  readonly encoding: string;
  decode(input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string;
}
declare var TextDecoder: { prototype: TextDecoder; new(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoder };

interface URLSearchParams {
  readonly size: number;
  append(name: string, value: string): void;
  delete(name: string, value?: string): void;
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string, value?: string): boolean;
  set(name: string, value: string): void;
  sort(): void;
  forEach(callback: (value: string, key: string, parent: URLSearchParams) => void): void;
  toString(): string;
  [Symbol.iterator](): IterableIterator<[string, string]>;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
}
declare var URLSearchParams: {
  prototype: URLSearchParams;
  new(init?: string[][] | Record<string, string> | string | URLSearchParams): URLSearchParams;
};
interface URL {
  hash: string;
  host: string;
  hostname: string;
  href: string;
  readonly origin: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  readonly searchParams: URLSearchParams;
  username: string;
  toString(): string;
  toJSON(): string;
}
declare var URL: {
  prototype: URL;
  new(url: string | URL, base?: string | URL): URL;
  canParse(url: string | URL, base?: string | URL): boolean;
  parse(url: string | URL, base?: string | URL): URL | null;
  createObjectURL(obj: Blob): string;
  revokeObjectURL(url: string): void;
};

interface Blob {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  slice(start?: number, end?: number, contentType?: string): Blob;
  text(): Promise<string>;
}
declare var Blob: { prototype: Blob; new(blobParts?: (BufferSource | Blob | string)[], options?: { type?: string }): Blob };
type BufferSource = ArrayBufferView | ArrayBuffer;

type HeadersInit = [string, string][] | Record<string, string> | Headers;
interface Headers {
  append(name: string, value: string): void;
  delete(name: string): void;
  get(name: string): string | null;
  getSetCookie(): string[];
  has(name: string): boolean;
  set(name: string, value: string): void;
  forEach(callback: (value: string, key: string, parent: Headers) => void): void;
  [Symbol.iterator](): IterableIterator<[string, string]>;
  entries(): IterableIterator<[string, string]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string>;
}
declare var Headers: { prototype: Headers; new(init?: HeadersInit): Headers };
type BodyInit = Blob | BufferSource | FormData | ReadableStream | URLSearchParams | string;
interface Body {
  readonly body: ReadableStream<Uint8Array> | null;
  readonly bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
  bytes(): Promise<Uint8Array>;
  json(): Promise<any>;
  text(): Promise<string>;
}
interface RequestInit {
  body?: BodyInit | null;
  cache?: "default" | "force-cache" | "no-cache" | "no-store" | "only-if-cached" | "reload";
  credentials?: "include" | "omit" | "same-origin";
  headers?: HeadersInit;
  integrity?: string;
  keepalive?: boolean;
  method?: string;
  mode?: "cors" | "navigate" | "no-cors" | "same-origin";
  redirect?: "error" | "follow" | "manual";
  referrer?: string;
  referrerPolicy?: string;
  signal?: AbortSignal | null;
}
interface Request extends Body {
  readonly headers: Headers;
  readonly method: string;
  readonly signal: AbortSignal;
  readonly url: string;
  clone(): Request;
}
declare var Request: { prototype: Request; new(input: RequestInfo | URL, init?: RequestInit): Request };
type RequestInfo = Request | string;
interface Response extends Body {
  readonly headers: Headers;
  readonly ok: boolean;
  readonly redirected: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly type: "basic" | "cors" | "default" | "error" | "opaque" | "opaqueredirect";
  readonly url: string;
  clone(): Response;
}
declare var Response: {
  prototype: Response;
  new(body?: BodyInit | null, init?: { headers?: HeadersInit; status?: number; statusText?: string }): Response;
  error(): Response;
  json(data: any, init?: { headers?: HeadersInit; status?: number; statusText?: string }): Response;
  redirect(url: string | URL, status?: number): Response;
};
declare function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
`;
