// Notebook-style code that must type-check against the globals entry.
import type { Displayable, MediaBundle } from "../../../src/globals.ts";

await jupyter.display(jupyter.md`**bold** ${1 + 1}`);
await jupyter.display(jupyter.html`<b>hi</b>`, { display_id: "d1" });
await jupyter.display({ "text/plain": "raw" }, { raw: true, update: true, display_id: "d1" });
const svg: Displayable = jupyter.svg`<svg></svg>`;
const img: Displayable = jupyter.image("plot.png");
const bundle: MediaBundle = await jupyter.format(new Uint8Array([1, 2]));
jupyter.broadcast("comm_msg", { comm_id: "x", data: {} }, { metadata: {}, buffers: [new Uint8Array(4)] });

class Badge implements Displayable {
  constructor(readonly label: string) {}
  [jupyter.$display](): MediaBundle {
    return { "text/html": `<span>${this.label}</span>` };
  }
}
await jupyter.display(new Badge("ok"));

const name: string | null = prompt("Name?", "anon", { password: false });
const sure: boolean = confirm("Sure?");

export { bundle, img, name, sure, svg };
