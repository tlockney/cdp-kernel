// Run with `deno run --check`: the namespace a Deno target installs as
// Deno.jupyter must cover every member of Deno's own `Deno.jupyter` type, so
// notebooks type-checked against Deno's lib don't call something missing.
import { createJupyter } from "../../../runtime/display.mjs";

// Exhaustive at compile time: `satisfies` rejects a missing or extra key.
const denoDeclared = {
  broadcast: true,
  display: true,
  format: true,
  md: true,
  html: true,
  svg: true,
  image: true,
  $display: true,
} satisfies Record<keyof typeof Deno.jupyter, true>;

const runtime = createJupyter({
  inspect: String,
  base64: () => "",
  readFile: () => new Uint8Array(),
  send: () => {},
  input: () => null,
}).namespace;

const missing = Object.keys(denoDeclared).filter((key) => !(key in runtime));
if (missing.length > 0) {
  console.error(`missing from the runtime namespace: ${missing.join(", ")}`);
  Deno.exit(1);
}
console.log("ok");
