/**
 * Ambient types for notebook cells run by cdp-kernel: the `jupyter` display
 * namespace and the stdin-backed `prompt`/`confirm`.
 *
 * Load it once per project, for example with
 * `/// <reference types="@tlockney/cdp-kernel/globals" />`. It ships in the
 * npm package only: Deno notebooks use `Deno.jupyter`, which Deno types.
 *
 * A custom display is a class with a `[jupyter.$display]()` method returning
 * a media bundle. At runtime that key is `Symbol.for("Jupyter.display")`, but
 * only `jupyter.$display` carries the precise type.
 *
 * @module
 */

// The shapes come from the runtime module's own declarations, so the
// globals can't drift from what the kernel installs.
import type { Displayable, DisplayOptions, JupyterNamespace, MediaBundle } from "../runtime/display.mjs";

export type { Displayable, DisplayOptions, JupyterNamespace, MediaBundle };

/** Options for the notebook's `prompt()`. */
export interface PromptOptions {
  /** Ask the frontend to hide what is typed, for secrets. Default `false`. */
  password?: boolean;
}

declare global {
  /**
   * The notebook display API: `display`, `md`/`html`/`svg` templates,
   * `image`, `format`, `broadcast`. The same object as `Deno.jupyter` in
   * `deno jupyter`.
   */
  var jupyter: JupyterNamespace;

  /**
   * Ask for a line of input in the notebook: the frontend shows an input
   * box under the cell, and the cell waits for the answer.
   *
   * @param message The question. Default `"Prompt"`. A non-empty
   *   `defaultValue` is shown after it, as `message [default]`.
   * @param defaultValue Returned when the answer is empty. Default `""`.
   * @param options `password: true` hides what is typed.
   * @returns The typed text, `defaultValue` for an empty answer, or `null`
   *   when nothing can answer (the frontend allows no input, as in
   *   `nbconvert --execute`).
   * @availability On workerd and celld it always returns `null`.
   * @example
   * ```ts
   * const name = prompt("What's your name?", "world");
   * `Hello, ${name}!`;
   * ```
   * @example
   * ```ts
   * const apiKey = prompt("API key", "", { password: true });
   * ```
   * @see jupyter-api.md#asking-for-input-prompt-and-confirm
   */
  function prompt(message?: string, defaultValue?: string, options?: PromptOptions): string | null;

  /**
   * Ask a yes/no question in the notebook. `[y/N]` is added to the message.
   *
   * @param message The question. Default `"Confirm"`.
   * @returns `true` only for `y` or `Y`; `false` otherwise, and when
   *   nothing can answer.
   * @availability On workerd and celld it always returns `false`.
   * @example
   * ```ts
   * if (confirm("Delete the cache?")) console.log("deleting");
   * ```
   * @see jupyter-api.md#asking-for-input-prompt-and-confirm
   */
  function confirm(message?: string): boolean;
}
