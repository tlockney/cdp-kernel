# Editor types

The kernel adds a few names to every notebook: `jupyter` (the
[display API](jupyter-api.md)), `prompt` and `confirm`, and with the
`cdp-node-deno` kernel a `Deno` object. They exist only while the kernel
runs your code. TypeScript has never heard of them, so an editor that
type-checks your code marks them as errors:

```text
Cannot find name 'jupyter'.
```

The code still runs. The kernel removes types before running a cell and
doesn't check them, so these errors come only from your editor. But they
hide real mistakes among false ones, and you get no completion or
signatures for `jupyter.display`, `jupyter.md` and the rest.

## Who needs this

You need it if your editor checks TypeScript that uses these names. The
common cases:

- Helper modules: a `.ts` file next to the notebook that cells import,
  which calls `jupyter.display` or `prompt`.
- Libraries that render themselves in notebooks with a
  [custom display](jupyter-api.md#custom-display-for-your-own-classes)
  method, `[jupyter.$display]()`.
- Notebook cells, in an editor that type-checks them.

If you only write cells and don't see these errors, you can skip this page.

## What you get

cdp-kernel's npm package ships declarations for these names. Once your
project loads them, the editor knows their types:

```ts
/// <reference types="@tlockney/cdp-kernel/globals" />
await jupyter.display(jupyter.md`typed`);      // completion and checking
const name: string | null = prompt("Name?", "", { password: true });
```

Misuse becomes an error before you run anything, for example
`jupyter.image(42)` (it takes a path or bytes) or treating `prompt`'s
result as a `string` when it can be `null`.

## Node notebooks

Add the package as a dev dependency:

```sh
npm install --save-dev @tlockney/cdp-kernel
```

Then load the declarations in one of two ways.

**A reference line**, once, at the top of any `.ts` file in the project
(or a cell). It applies to the whole project:

```ts
/// <reference types="@tlockney/cdp-kernel/globals" />
```

**Or `tsconfig.json`**, which VS Code and other editors read for every
file in the project:

```json
{
  "compilerOptions": {
    "module": "nodenext",
    "types": ["node", "@tlockney/cdp-kernel/globals"]
  }
}
```

Two details about this file:

- `types` replaces TypeScript's default of loading every installed
  `@types` package, so list any others the project uses, such as `"node"`.
- The `.../globals` path only resolves with `module` set to `nodenext` or
  `node16`, or `moduleResolution` set to `bundler`.

**With the `cdp-node-deno` kernel**, use
`@tlockney/cdp-kernel/globals/deno-compat` instead. It declares
everything above plus the `Deno` object that kernel provides on Node, and
only the parts of it the kernel implements. It is separate because on a
real Deno, `Deno` is already declared.

## Deno notebooks

Deno already declares `Deno.jupyter`, the same object as `jupyter`, so
write `Deno.jupyter.display(...)` and nothing needs installing. The JSR
package can't ship the `jupyter` global's declaration, because JSR doesn't
allow packages to declare globals.

## Custom display

A class shows itself in a notebook through a method keyed by
`jupyter.$display`, returning a MIME bundle (see
[Custom display for your own classes](jupyter-api.md#custom-display-for-your-own-classes)).
At runtime the key is `Symbol.for("Jupyter.display")`, but use `jupyter.$display` in typed code:
only it carries the method's type, so the editor checks what you return.

```ts
class Point {
  constructor(public x: number, public y: number) {}
  [jupyter.$display]() {
    return { "text/plain": `(${this.x}, ${this.y})` };
  }
}
```
