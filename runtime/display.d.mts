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
}

export interface Jupyter {
  namespace: JupyterNamespace;
  broadcastResult(executionCount: number, result: unknown): Promise<void>;
  confirm(message?: string): boolean;
  prompt(message?: string, defaultValue?: string, options?: { password?: boolean }): string | null;
  /** Routes a frontend comm message into the kernel's comms. */
  commDispatch: Comms["dispatch"];
}

export function escapeHTML(str: string): string;
export function isJpg(obj: unknown): boolean;
export function isPng(obj: unknown): boolean;
export function createJupyter(host: DisplayHost): Jupyter;
