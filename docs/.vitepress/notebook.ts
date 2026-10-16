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
//
// A page can also show a whole notebook that already has outputs, such as
// the ones in examples/, with a line of its own:
//
//   @[notebook](../examples/moma-collection.node.ipynb)
//
// GitHub shows that line as a link to the notebook, which it renders.
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
  if (typeof svg === "string") {
    // As an <img>, so its styles stay its own. That needs the SVG namespace,
    // which SVG built with a server-side DOM (linkedom) often leaves out.
    const doc = /<svg\b[^>]*\bxmlns=/.test(svg) ? svg : svg.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
    return `<img class="nb-image" alt="SVG output" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(doc)}">`;
  }
  for (const mime of ["image/png", "image/jpeg", "image/gif"]) {
    const img = get(mime);
    if (typeof img === "string") return `<img class="nb-image" alt="Image output" src="${dataURI(mime, img)}">`;
  }
  const vega = get("application/vnd.vegalite.v5+json") ?? get("application/vnd.vegalite.v4+json");
  if (vega !== undefined) {
    // Drawn in the browser by the theme (theme/vega.ts), from this spec.
    return `<div class="nb-vega" data-spec="${escapeHTML(JSON.stringify(vega))}"></div>`;
  }
  if (get("application/vnd.jupyter.widget-view+json") !== undefined) {
    return `<p class="nb-note">An interactive widget. It runs in JupyterLab, Notebook 7 or VS Code, not on this page.</p>`;
  }
  const markdown = get("text/markdown");
  if (typeof markdown === "string") {
    // Headings in output belong to the output, not the page: without ids they
    // stay out of the outline and get no anchor link.
    const html = md.render(markdown, { ...(env as object), headers: [] })
      .replace(/<(h[1-6])\b[^>]*>/g, "<$1>")
      .replace(/<a class="header-anchor"[^>]*>[\s\S]*?<\/a>/g, "");
    return `<div class="nb-markdown">${html}</div>`;
  }
  const json = get("application/json");
  if (json !== undefined) return `<pre class="nb-stream">${escapeHTML(JSON.stringify(json, null, 2))}</pre>`;
  const plain = get("text/plain");
  if (typeof plain === "string") return `<pre class="nb-stream">${ansiToHTML(plain)}</pre>`;
  return "";
}

/** Marks table cells that hold just a number, so they can be right-aligned. */
const numberCells = (html: string) =>
  html.replace(/<td(\s[^>]*)?>(\s*[-+−]?[\d,.]+(?:e[-+]?\d+)?%?\s*)<\/td>/gi, (td, attrs = "", n) =>
    /\bclass=/.test(attrs) ? td : `<td${attrs} class="nb-num">${n}</td>`);

/** A cell's outputs. */
export function renderOutputs(md: MarkdownIt, cell: Cell, env: unknown): string {
  const outputs = (cell.outputs ?? []).map((o) => numberCells(renderOutput(md, o, env))).filter(Boolean);
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

/** Notebooks outside docs/public/ that pages offer for download, by published name. */
export const published = new Map<string, string>();

export interface Options {
  /** docs/ on disk. */
  docsDir: string;
  /** Where a notebook is downloaded from, by its path under docs/. */
  downloadHref: (rel: string) => string;
  /** Where a notebook is viewed on GitHub, by its path in the repository. */
  viewHref: (rel: string) => string;
}

function bar(file: string, opts: Options, text: string): string {
  const rel = path.relative(opts.docsDir, file).split(path.sep).join("/");
  const name = path.basename(file);
  let href: string;
  if (rel.startsWith("public/")) href = opts.downloadHref(rel);
  else {
    published.set(name, file);
    href = opts.downloadHref(`public/notebooks/${name}`);
  }
  const view = opts.viewHref(path.relative(path.dirname(opts.docsDir), file).split(path.sep).join("/"));
  return `<div class="nb-bar"><span>${text}</span>
<span class="nb-bar-links"><a href="${href}" download="${escapeHTML(name)}" target="_self">Download ${escapeHTML(name)}</a> · <a href="${view}">View on GitHub</a></span></div>\n`;
}

const fenceLang: Record<string, string> = { typescript: "ts", javascript: "js", python: "py" };

/** Code cells longer than this many lines start folded. */
const foldAt = 20;

/** A code cell: its highlighted code, folded when long, and its outputs. */
function cellHTML(md: MarkdownIt, code: string, cell: Cell, env: unknown): string {
  const lines = join(cell.source).replace(/\n+$/, "").split("\n").length;
  const fold = lines > foldAt
    ? `<button class="nb-unfold" type="button" aria-expanded="false">Show all ${lines} lines</button>`
    : "";
  return `<div class="nb-cell${fold ? " nb-folded" : ""}">${code}${fold}${renderOutputs(md, cell, env)}</div>`;
}

/** A whole notebook: Markdown cells as prose, code cells with their outputs. */
function renderNotebook(md: MarkdownIt, file: string, env: unknown, opts: Options): string {
  const notebook = readNotebook(file);
  const kernel = notebook.metadata.kernelspec?.name;
  const lang = fenceLang[(notebook.metadata as { language_info?: { name?: string } }).language_info?.name ?? ""] ?? "ts";
  let html = bar(file, opts, `A notebook run on the ${kernel ? `<code>${escapeHTML(kernel)}</code> ` : ""}kernel, shown with its saved output.`);
  for (const [i, cell] of notebook.cells.entries()) {
    let source = join(cell.source);
    // The page gives the title; drop the notebook's own.
    if (i === 0 && cell.cell_type === "markdown") source = source.replace(/^# .*\n?/, "");
    if (cell.cell_type === "markdown") html += md.render(source, env);
    else if (cell.cell_type === "code") {
      const fence = "`".repeat(Math.max(3, ...(source.match(/`+/g) ?? []).map((t) => t.length + 1)));
      const code = md.render(`${fence}${lang}\n${source}\n${fence}\n`, env);
      html += cellHTML(md, code, cell, env);
    }
  }
  return html;
}

export function notebookPlugin(md: MarkdownIt, opts: Options) {
  md.block.ruler.before("paragraph", "notebook", (state, start, _end, silent) => {
    const line = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
    const match = line.match(/^@\[notebook\]\(([^)\s]+\.ipynb)\)\s*$/);
    if (!match) return false;
    if (silent) return true;
    const token = state.push("notebook", "", 0);
    token.info = match[1];
    token.map = [start, start + 1];
    state.line = start + 1;
    return true;
  });
  md.renderer.rules.notebook = (tokens, idx, _options, env) => {
    const file = path.resolve(path.dirname(env.path), tokens[idx].info);
    if (!fs.existsSync(file)) throw new Error(`${env.path}: ${file} doesn't exist`);
    return renderNotebook(md, file, env, opts);
  };

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
    return cellHTML(md, code, cell, env);
  };

  // The marker comment becomes a bar offering the notebook for download.
  const htmlBlock = md.renderer.rules.html_block!;
  md.renderer.rules.html_block = (tokens, idx, options, env, self) => {
    const match = tokens[idx].content.match(markerRE);
    if (!match) return htmlBlock(tokens, idx, options, env, self);
    const file = path.resolve(path.dirname(env.path), match[1]);
    const kernel = fs.existsSync(file) ? readNotebook(file).metadata.kernelspec?.name : undefined;
    return bar(file, opts, `This page is also a notebook. Its examples ran on the ${kernel ? `<code>${escapeHTML(kernel)}</code> ` : ""}kernel, and the output shown is what they produced.`);
  };
}
