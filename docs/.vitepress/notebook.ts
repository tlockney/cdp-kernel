// Shows docs examples as notebook cells with the output they really
// produced.
//
// A page opts in with a comment naming its notebook:
//
//   <!-- notebook: notebooks/getting-started.ipynb -->
//
// and marks the code blocks that are cells with `cell` after the language
// (```ts cell). `npm run docs:notebooks` (run-notebooks.ts) builds that
// notebook from the page and runs it on the kernel; the build here then
// shows each marked block as a cell with the outputs saved in the notebook.
// The Markdown stays the source, so the page still reads normally on GitHub,
// and readers can download the notebook. A marked block with no matching
// cell fails the build, so the docs never show code that wasn't run.
import fs from "node:fs";
import path from "node:path";
import type MarkdownIt from "markdown-it";

export interface Output {
  output_type: "stream" | "execute_result" | "display_data" | "error";
  name?: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  execution_count?: number | null;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface Cell {
  cell_type: "code" | "markdown" | "raw";
  source: string | string[];
  outputs?: Output[];
  execution_count?: number | null;
  metadata?: Record<string, unknown>;
}

export interface Notebook {
  cells: Cell[];
  metadata: { kernelspec?: { name: string; display_name: string } };
}

export const markerRE = /^<!--\s*notebook:\s*(\S+\.ipynb)\s*-->\s*$/m;

export const join = (s: string | string[] | undefined) => (Array.isArray(s) ? s.join("") : (s ?? ""));

/** A cell's source compared loosely: trailing whitespace doesn't matter. */
export const normalize = (s: string) => s.replace(/\s+$/, "");

/** Whether a fence's info string (`ts cell`) marks it as a notebook cell. */
export const isCell = (info: string) => /^\S+\s+cell\b/.test(info.trim());

const escapeHTML = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

// SGR colors as Node's util.inspect and Deno.inspect emit them.
const sgrClass: Record<number, string> = {
  1: "b", 2: "dim", 3: "i", 4: "u",
  30: "black", 31: "red", 32: "green", 33: "yellow", 34: "blue", 35: "magenta", 36: "cyan", 37: "white",
  90: "gray", 91: "red", 92: "green", 93: "yellow", 94: "blue", 95: "magenta", 96: "cyan", 97: "white",
};

/** Plain text with ANSI color codes, as HTML spans. */
export function ansiToHTML(text: string): string {
  let fg = "";
  const styles = new Set<string>();
  let out = "";
  for (const [i, part] of text.split(/\x1b\[([0-9;]*)m/).entries()) {
    if (i % 2 === 1) {
      for (const code of (part || "0").split(";").map(Number)) {
        if (code === 0) (fg = ""), styles.clear();
        else if (code === 22) styles.delete("b"), styles.delete("dim");
        else if (code === 23) styles.delete("i");
        else if (code === 24) styles.delete("u");
        else if (code === 39) fg = "";
        else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = sgrClass[code];
        else if (sgrClass[code]) styles.add(sgrClass[code]);
      }
      continue;
    }
    if (!part) continue;
    const classes = [fg, ...styles].filter(Boolean).map((c) => `ansi-${c}`);
    out += classes.length ? `<span class="${classes.join(" ")}">${escapeHTML(part)}</span>` : escapeHTML(part);
  }
  return out;
}

const dataURI = (mime: string, data: string) => `data:${mime};base64,${data.replace(/\s+/g, "")}`;

/** One output as HTML, choosing the richest type a browser can show. */
export function renderOutput(md: MarkdownIt, output: Output, env: unknown): string {
  if (output.output_type === "stream") {
    const cls = output.name === "stderr" ? "nb-stream nb-stderr" : "nb-stream";
    return `<pre class="${cls}">${ansiToHTML(join(output.text).replace(/\n$/, ""))}</pre>`;
  }
  if (output.output_type === "error") {
    const tb = output.traceback?.length ? output.traceback.join("\n") : `${output.ename}: ${output.evalue}`;
    return `<pre class="nb-stream nb-stderr">${ansiToHTML(tb)}</pre>`;
  }
  const data = output.data ?? {};
  const get = (mime: string) => (mime in data ? (typeof data[mime] === "string" || Array.isArray(data[mime]) ? join(data[mime] as string | string[]) : data[mime]) : undefined);
  const html = get("text/html");
  if (typeof html === "string") return `<div class="nb-html">${html.replace(/<script\b[\s\S]*?<\/script>/gi, "")}</div>`;
  const svg = get("image/svg+xml");
  if (typeof svg === "string") return `<img class="nb-image" alt="SVG output" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}">`;
  for (const mime of ["image/png", "image/jpeg", "image/gif"]) {
    const img = get(mime);
    if (typeof img === "string") return `<img class="nb-image" alt="Image output" src="${dataURI(mime, img)}">`;
  }
  const markdown = get("text/markdown");
  if (typeof markdown === "string") return `<div class="nb-markdown">${md.render(markdown, env)}</div>`;
  const json = get("application/json");
  if (json !== undefined) return `<pre class="nb-stream">${escapeHTML(JSON.stringify(json, null, 2))}</pre>`;
  const plain = get("text/plain");
  if (typeof plain === "string") return `<pre class="nb-stream">${ansiToHTML(plain)}</pre>`;
  return "";
}

/** A cell's outputs, in a frame labelled with its execution count. */
export function renderOutputs(md: MarkdownIt, cell: Cell, env: unknown): string {
  const outputs = (cell.outputs ?? []).map((o) => renderOutput(md, o, env)).filter(Boolean);
  if (!outputs.length) return "";
  return `<div class="nb-outputs" v-pre>${outputs.map((o) => `<div class="nb-output">${o}</div>`).join("")}</div>`;
}

const cache = new Map<string, { mtime: number; notebook: Notebook }>();

export function readNotebook(file: string): Notebook {
  const mtime = fs.statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit?.mtime === mtime) return hit.notebook;
  const notebook = JSON.parse(fs.readFileSync(file, "utf8")) as Notebook;
  cache.set(file, { mtime, notebook });
  return notebook;
}

/** The notebook a page names in its marker comment, if any. */
export function pageNotebook(page: string): string | undefined {
  const match = fs.readFileSync(page, "utf8").match(markerRE);
  return match ? path.resolve(path.dirname(page), match[1]) : undefined;
}

export interface Options {
  /** docs/ on disk. */
  docsDir: string;
  /** Where the published notebook is downloaded from, by its path under docs/. */
  downloadHref: (rel: string) => string;
  /** Where it's viewed on GitHub, by its path under docs/. */
  viewHref: (rel: string) => string;
}

export function notebookPlugin(md: MarkdownIt, opts: Options) {
  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const code = fence(tokens, idx, options, env, self);
    if (!isCell(token.info)) return code;
    const page: string = env.path;
    const file = pageNotebook(page);
    if (!file) throw new Error(`${page}: a \`cell\` code block needs a <!-- notebook: … --> comment on the page`);
    if (!fs.existsSync(file)) throw new Error(`${page}: ${file} is missing; run npm run docs:notebooks`);
    const want = normalize(token.content);
    const cell = readNotebook(file).cells.find((c) => c.cell_type === "code" && normalize(join(c.source)) === want);
    if (!cell) {
      throw new Error(
        `${page}: a \`cell\` code block isn't in ${path.relative(opts.docsDir, file)} as written; run npm run docs:notebooks\n${want}`,
      );
    }
    const count = cell.execution_count ?? " ";
    return `<div class="nb-cell"><div class="nb-prompt">[${count}]</div>${code}${renderOutputs(md, cell, env)}</div>`;
  };

  // The marker comment becomes a bar offering the notebook for download.
  const htmlBlock = md.renderer.rules.html_block!;
  md.renderer.rules.html_block = (tokens, idx, options, env, self) => {
    const match = tokens[idx].content.match(markerRE);
    if (!match) return htmlBlock(tokens, idx, options, env, self);
    const file = path.resolve(path.dirname(env.path), match[1]);
    const rel = path.relative(opts.docsDir, file).split(path.sep).join("/");
    const kernel = fs.existsSync(file) ? readNotebook(file).metadata.kernelspec?.name : undefined;
    return `<div class="nb-bar"><span>This page is also a notebook. Its examples ran on the ${kernel ? `<code>${escapeHTML(kernel)}</code> ` : ""}kernel, and the output shown is what they produced.</span>
<span class="nb-bar-links"><a href="${opts.downloadHref(rel)}" download="${path.basename(rel)}" target="_self">Download ${escapeHTML(path.basename(rel))}</a> · <a href="${opts.viewHref(rel)}">View on GitHub</a></span></div>\n`;
  };
}
