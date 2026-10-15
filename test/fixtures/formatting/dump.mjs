// Prints each case in values.mjs as a JSON line { name, text }, formatted the
// way the runtime's kernel target formats results (#17): util.inspect on
// Node, Deno.inspect on Deno, depth 4, without colors so they compare.
import { cases } from "./values.mjs";

const isDeno = typeof Deno !== "undefined";
const util = isDeno ? null : await import("node:util");
const format = (v) => (isDeno ? Deno.inspect(v, { colors: false, depth: 4 }) : util.inspect(v, { colors: false, depth: 4 }));
// A Promise is shown once settled, as it would be by display time.
await new Promise((r) => setTimeout(r, 10));
for (const [name, value] of Object.entries(cases)) {
  console.log(JSON.stringify({ name, text: format(value) }));
}
