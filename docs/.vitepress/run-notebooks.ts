// Builds the notebook behind each docs page that names one, and runs it.
//
//   npm run docs:notebooks [page.md ...]
//
// A page names its notebook with <!-- notebook: notebooks/name.ipynb --> and
// marks its cells as ```ts cell (see notebook.ts). Each marked block becomes
// a code cell; the prose around it becomes Markdown cells, so the downloaded
// notebook reads like the page. The notebook is then run with nbclient
// (run_notebook.py, through uv) on this checkout's cdp-node kernel, which
// saves the outputs the site shows and the state of any widgets. A cell
// that fails stops the run.
//
// A cell that shows a widget can be followed by a comment scripting what
// its view sends the kernel, as a click or a slider would:
//
//   <!-- view sends for a slider move to 30: [{"method": "update", "state": {"celsius": 30}}] -->
//
// The words before the colon say what a person would have done, for the
// note under the widget. Each entry is the data of one comm message from
// the view (an anywidget state update, or {"method": "custom", "content":
// ...}). The runner sends them after the cell runs and saves the kernel's
// replies with the output, so the page shows the widget as the kernel
// left it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isCell, markerRE, viewSendsRE, type Cell, type Notebook } from "./notebook.ts";

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
  // Frontmatter configures the page, not the notebook.
  const lines = markdown.replace(/^---\n[\s\S]*?\n---\n/, "").replace(markerRE, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (!open) {
      // One that didn't follow a cell block, or that viewSendsRE doesn't
      // match (indented, over two lines, not a list), would otherwise end up
      // as a hidden comment with nothing sent.
      if (/^\s*<!--\s*view sends\b/.test(lines[i])) {
        throw new Error(`${page}: a view sends comment must directly follow a cell block, on one line, as <!-- view sends for <words>: [...] -->: ${lines[i].trim()}`);
      }
      prose.push(lines[i]);
      continue;
    }
    const [, indent, fence, info] = open;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !lines[j].trimStart().startsWith(fence)) body.push(lines[j++].slice(indent.length));
    if (isCell(info) && !indent) {
      flush();
      const metadata: Record<string, unknown> = {};
      // A <!-- view sends for …: --> comment after the block, past blank lines,
      // scripts what a widget's view sends the kernel once the cell has run.
      let k = j + 1;
      while (k < lines.length && !lines[k].trim()) k++;
      const sends = lines[k]?.match(viewSendsRE);
      if (sends) {
        let view_sends: unknown;
        try {
          view_sends = JSON.parse(sends[2]);
        } catch (error) {
          throw new Error(`${page}: the view sends comment isn't valid JSON (${error}): ${lines[k].trim()}`);
        }
        metadata.docs = { view_sent: sends[1].trim(), view_sends };
        lines.splice(k, 1);
      }
      cells.push({ cell_type: "code", source: body.join("\n"), metadata, outputs: [], execution_count: null });
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

const runner = path.join(import.meta.dirname, "run_notebook.py");

/**
 * The executed notebook in a form that a re-run with the same results
 * leaves unchanged: no execution timing, widget model ids numbered in
 * order of appearance rather than random, and each cell's keys in one
 * order with its source as one string.
 */
export function stable(json: string): string {
  const saved = JSON.parse(json).metadata.widgets?.["application/vnd.jupyter.widget-state+json"]?.state ?? {};
  const ids = new Map<string, string>();
  // Model ids appear in outputs, in the saved state and in references
  // between models; renaming them in the text catches all three.
  json = json.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}/g, (id) => {
    if (!(id in saved)) return id;
    if (!ids.has(id)) ids.set(id, `widget-${ids.size + 1}`);
    return ids.get(id)!;
  });
  const nb = JSON.parse(json);
  const { language_info: _, ...metadata } = nb.metadata;
  const cells = nb.cells.map((cell: Cell & { id: string }) => {
    const { execution: __, ...cellMetadata } = cell.metadata ?? {};
    return {
      id: cell.id,
      cell_type: cell.cell_type,
      source: Array.isArray(cell.source) ? cell.source.join("") : cell.source,
      metadata: cellMetadata,
      ...(cell.cell_type === "code" ? { outputs: cell.outputs, execution_count: cell.execution_count } : {}),
    };
  });
  return JSON.stringify({ cells, metadata, nbformat: nb.nbformat, nbformat_minor: nb.nbformat_minor }, null, 1) + "\n";
}

if (import.meta.main) {
  const pages = process.argv.length > 2
    ? process.argv.slice(2).map((p) => path.resolve(p))
    : fs.readdirSync(docsDir).filter((f) => f.endsWith(".md")).map((f) => path.join(docsDir, f));

  for (const page of pages) {
    const file = build(page);
    if (!file) continue;
    console.log(`running ${path.relative(process.cwd(), file)}`);
    execFileSync("uv", ["run", "-q", "--with", "nbclient", "--with", "nbformat", "python", runner, file], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    fs.writeFileSync(file, stable(fs.readFileSync(file, "utf8")));
  }
}
