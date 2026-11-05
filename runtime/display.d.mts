import type { CommApi, Comms } from "./comm.d.mts";
import type { Widget, WidgetOptions } from "./widget.d.mts";

export type { CommApi, Widget, WidgetOptions };

export const $display: unique symbol;

export type MediaBundle = { [mediaType: string]: unknown };

export interface DisplayHost {
  inspect: (value: unknown) => string;
  base64: (bytes: Uint8Array) => string;
  readFile: (path: string) => Uint8Array;
  send: (msgType: string, content: object, metadata: object, buffers: Uint8Array[]) => void;
  input: (prompt: string, password: boolean) => string | null;
}

export interface DisplayOptions {
  raw?: boolean;
  update?: boolean;
  display_id?: string;
}

export interface Displayable {
  [$display]: () => MediaBundle | Promise<MediaBundle>;
}

export interface JupyterNamespace {
  broadcast(
    msgType: string,
    content: object,
    options?: { metadata?: object; buffers?: Uint8Array[] },
  ): void;
  display(obj: unknown, options?: DisplayOptions): Promise<void>;
  format(obj: unknown): Promise<MediaBundle>;
  md(strings: TemplateStringsArray, ...values: unknown[]): Displayable;
  html(strings: TemplateStringsArray, ...values: unknown[]): Displayable;
  svg(strings: TemplateStringsArray, ...values: unknown[]): Displayable;
  image(obj: string | Uint8Array): Displayable;
  $display: typeof $display;
  /** Jupyter comms: bidirectional channels to the frontend. */
  comm: CommApi;
  /** An anywidget-compatible widget; display the result to show it. */
  widget(options: WidgetOptions): Widget;
  /**
   * Aborted when the kernel interrupts this cell. Each cell gets its own,
   * as does a comm handler that starts while no cell runs. Read it when
   * the work starts: a later read gets the signal of whatever started last.
   */
  readonly signal: AbortSignal;
}

export interface Jupyter {
  namespace: JupyterNamespace;
  broadcastResult(executionCount: number, result: unknown): Promise<void>;
  /** format without awaiting; a $display method's promise is returned as is. */
  formatNow(obj: unknown): unknown;
  confirm(message?: string): boolean;
  prompt(message?: string, defaultValue?: string, options?: { password?: boolean }): string | null;
  /**
   * Routes a frontend comm message into the kernel's comms. `ownSignal`
   * (no cell is running) gives its handlers their own jupyter.signal.
   */
  commDispatch(
    msgType: string,
    content: { [key: string]: unknown },
    metadata: { [key: string]: unknown },
    buffers: Uint8Array[],
    ownSignal?: boolean,
  ): Promise<boolean>;
  /** A new jupyter.signal: a cell is starting (#421). */
  startCell(): void;
  /**
   * Aborts the running comm handlers' jupyter.signal, and the last cell's
   * unless `cellRunning` is false: the kernel was interrupted.
   */
  abortSignal(cellRunning?: boolean): void;
}

export function escapeHTML(str: string): string;
export function isJpg(obj: unknown): boolean;
export function isPng(obj: unknown): boolean;
export function createJupyter(host: DisplayHost): Jupyter;
