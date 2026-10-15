// Misuse the globals entry must reject. Each @ts-expect-error fails the
// type check if its line stops being an error.
import type {} from "../../../src/globals.ts";

// @ts-expect-error display needs an object to show
await jupyter.display();
// @ts-expect-error display options are typed
await jupyter.display("x", { displayId: "wrong-case" });
// @ts-expect-error not part of the namespace
jupyter.render("x");
// @ts-expect-error image takes a path or bytes
jupyter.image(42);
// @ts-expect-error prompt returns string | null
const s: string = prompt("x");
// @ts-expect-error the Deno namespace is a separate, opt-in entry
Deno.readTextFileSync("x");

export { s };
