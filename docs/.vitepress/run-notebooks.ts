// Builds the notebook behind each docs page that names one, and runs it.
//
//   npm run docs:notebooks [page.md ...]
//
// A page names its notebook with <!-- notebook: notebooks/name.ipynb --> and
// marks its cells as ```ts cell (see notebook.ts). Each marked block becomes
// a code cell; the prose around it becomes Markdown cells, so the downloaded
// notebook reads like the page. The notebook is then run with nb-cli
// (https://github.com/jupyter-ai-contrib/nb-cli) on the cdp-node kernel,
// which saves the outputs the site shows. Install a kernelspec first, from
// this checkout (npm run install:node) or a release.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isCell, markerRE, type Cell, type Notebook } from "./notebook.ts";

const docsDir = path.resolve(import.meta.dirname, "..");
const site = "https://cdp-kernel.org";
const repo = "https://github.com/tlockney/cdp-kernel";
const kernelspec = { name: "cdp-node", display_name: "TypeScript (cdp-kernel, node)", language: "typescript" };

// Links in the notebook point at the published docs, since the notebook
// doesn't sit beside the pages once downloaded.
function absoluteLinks(text: string, page: string): string {
  return text.replace(/(!?)\[([^\]]*)\]\((?![a-z][a-z0-9+.-]*:|#)([^)\s]+)\)/gi, (_, image: string, label: string, href: string) => {
    const [target, hash = ""] = href.split(/(?=#)/);
    const abs = path.resolve(path.dirname(page), target);
    const rel = path.relative(path.dirname(docsDir), abs);
    if (image) return `![${label}](${repo.replace("github.com", "raw.githubusercontent.com")}/main/${rel})`;
    if (abs.startsWith(docsDir + path.sep) && abs.endsWith(".md")) {
      const name = path.relative(docsDir, abs).replace(/(^|\/)README\.md$/, "$1").replace(/\.md$/, "");
      return `[${label}](${site}/docs/${name}${hash})`;
    }
    return `[${label}](${repo}/blob/main/${rel}${hash})`;
  });
}

/** The page split into Markdown cells and the code cells it marks. */
export function cellsOf(markdown: string, page: string): Cell[] {
  const cells: Cell[] = [];
  let prose: string[] = [];
  const flush = () => {
    const text = prose.join("\n").trim();
    if (text) cells.push({ cell_type: "markdown", source: absoluteLinks(text, page), metadata: {} });
    prose = [];
  };
  const lines = markdown.replace(markerRE, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (!open) {
      prose.push(lines[i]);
      continue;
    }
    const [, indent, fence, info] = open;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !lines[j].trimStart().startsWith(fence)) body.push(lines[j++].slice(indent.length));
    if (isCell(info) && !indent) {
      flush();
      cells.push({ cell_type: "code", source: body.join("\n"), metadata: {}, outputs: [], execution_count: null });
    } else {
      prose.push(...lines.slice(i, j + 1));
    }
    i = j;
  }
  flush();
  return cells;
}

function build(page: string): string | undefined {
  const markdown = fs.readFileSync(page, "utf8");
  const match = markdown.match(markerRE);
  if (!match) return;
  const file = path.resolve(path.dirname(page), match[1]);
  const cells = cellsOf(markdown, page).map((cell, i) => ({
    id: createHash("sha256").update(`${i}\0${cell.source}`).digest("hex").slice(0, 12),
    ...cell,
  }));
  const notebook: Notebook & { nbformat: number; nbformat_minor: number } = {
    cells,
    metadata: { kernelspec },
    nbformat: 4,
    nbformat_minor: 5,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(notebook, null, 1) + "\n");
  return file;
}

const pages = process.argv.length > 2
  ? process.argv.slice(2).map((p) => path.resolve(p))
  : fs.readdirSync(docsDir).filter((f) => f.endsWith(".md")).map((f) => path.join(docsDir, f));

for (const page of pages) {
  const file = build(page);
  if (!file) continue;
  console.log(`running ${path.relative(process.cwd(), file)}`);
  // nb runs the notebook in its own directory and saves the outputs into it.
  execFileSync("nb", ["execute", file, "--timeout", "180"], { stdio: ["ignore", "ignore", "inherit"] });
  // Outputs are only as stable as the code: drop execution timing metadata
  // so a re-run with the same results leaves the file unchanged.
  const notebook = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const cell of notebook.cells) delete cell.metadata?.execution;
  fs.writeFileSync(file, JSON.stringify(notebook, null, 1) + "\n");
}
