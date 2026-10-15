/**
 * Ambient types for notebook cells run by cdp-kernel: the `jupyter` display
 * namespace and the stdin-backed `prompt`/`confirm`.
 *
 * Load it once per project, for example
 * `/// <reference types="@tlockney/cdp-kernel/globals" />` (npm) or
 * `import type {} from "jsr:@tlockney/cdp-kernel/globals";` (Deno).
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
  /** Ask the frontend to hide what is typed. */
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
   * Ask the frontend for a line of input over the Jupyter stdin channel.
   * Returns `null` when the frontend didn't allow input for this cell.
   */
  function prompt(message?: string, defaultValue?: string, options?: PromptOptions): string | null;

  /** Ask a yes/no question over the Jupyter stdin channel. */
  function confirm(message?: string): boolean;
}
