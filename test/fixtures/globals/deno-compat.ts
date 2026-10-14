// Node-with-compat notebook code: the opt-in entry adds the Deno namespace.
import type {} from "../../../src/globals-deno-compat.ts";

const text: string = await Deno.readTextFile("note.txt");
Deno.writeTextFileSync("out.txt", text, { append: true });
for await (const entry of Deno.readDir(".")) {
  const isFile: boolean = entry.isFile;
  void isFile;
}
try {
  await Deno.stat("missing");
} catch (err) {
  if (err instanceof Deno.errors.NotFound) console.log("missing");
}
// Deno.jupyter is the same namespace as the jupyter global.
await Deno.jupyter.display(jupyter.md`same namespace`);
const os: string = Deno.build.os;

export { os };
