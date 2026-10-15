# Editor types

Cells run untyped, as in `deno jupyter`. Notebook code your editor
type-checks can declare the globals.

**Node notebooks.** The npm package ships the declarations. Add it as a dev
dependency, then reference it once from a cell or a `.d.ts` in the project:

```ts
/// <reference types="@tlockney/cdp-kernel/globals" />
await jupyter.display(jupyter.md`typed`);
const name: string | null = prompt("Name?", "", { password: false });
```

That declares `jupyter`, `prompt` and `confirm`. With the `cdp-node-deno`
kernel, use `@tlockney/cdp-kernel/globals/deno-compat` instead: it adds the
`Deno` namespace the compatibility shim implements. A custom display is a
class with a `[jupyter.$display]()` method returning a MIME bundle.
`jupyter.$display` is `Symbol.for("Jupyter.display")` at runtime, but only
`jupyter.$display` carries the precise type.

**Deno notebooks.** Use `Deno.jupyter`, which Deno already types and which a
Deno target provides. The JSR package doesn't ship these globals, because
JSR doesn't allow packages to augment global types.
