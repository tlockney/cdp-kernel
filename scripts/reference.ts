// Generates the API reference pages (docs/jupyter-reference.md,
// docs/widgets-reference.md) from the TSDoc on the types notebooks see
// (ganymede#596). The doc comments are the source: editors show the same
// text on hover. `node scripts/reference.ts --write` rewrites the pages;
// with no flag it checks them, which test/reference.test.ts does too.
//
// Tags read: the summary, @param, @returns, @throws {Type}, @availability
// (where it doesn't work everywhere), @example (a ```ts block; CI
// type-checks each one; it may be followed by screenshots of its output,
// as ![alt](https://cdp-kernel.org/images/...) of a file in docs/images/),
// and @see <guide page>#<anchor>.

import ts from "typescript";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));

interface Section {
  /** The interface whose members are documented. */
  iface: string;
  file: string;
  /** How a member is named in headings: `jupyter.`, `widget.` */
  prefix: string;
  heading: string;
  intro?: string;
}

interface Page {
  file: string;
  title: string;
  intro: string;
  sections: Section[];
  /** Global functions declared in src/globals.ts. */
  globals?: string[];
  /** Option and value types, as property tables. */
  types: { name: string; file: string }[];
}

/** Where the site publishes docs/images/ (pages.yml), for images in doc comments. */
const IMAGES = "https://cdp-kernel.org/images/";

const DISPLAY = "runtime/display.d.mts";
const COMM = "runtime/comm.d.mts";
const WIDGET = "runtime/widget.d.mts";
const GLOBALS = "src/globals.ts";

export const pages: Page[] = [
  {
    file: "docs/jupyter-reference.md",
    title: "`jupyter` reference",
    intro: `Every member of the \`jupyter\` global and the \`prompt\` and \`confirm\`
globals, with their arguments, return values and an example. [The
\`jupyter\` namespace](jupyter-api.md) explains them with longer examples
and their output. Widgets and comms are in the [widgets
reference](widgets-reference.md).`,
    sections: [{ iface: "JupyterNamespace", file: DISPLAY, prefix: "jupyter.", heading: "jupyter" }],
    globals: ["prompt", "confirm"],
    types: [
      { name: "DisplayOptions", file: DISPLAY },
      { name: "PromptOptions", file: GLOBALS },
      { name: "MediaBundle", file: DISPLAY },
      { name: "Displayable", file: DISPLAY },
    ],
  },
  {
    file: "docs/widgets-reference.md",
    title: "Widgets and comms reference",
    intro: `The widget model that \`jupyter.widget(options)\` returns, and the comm
API under \`jupyter.comm\`, with their arguments, return values and an
example. [Widgets and comms](widgets.md) explains them with a full
walk-through, including the view module.`,
    sections: [
      {
        iface: "Widget",
        file: WIDGET,
        prefix: "widget.",
        heading: "Widget model",
        intro: "`jupyter.widget(options)` returns it; see the [`jupyter` reference](jupyter-reference.md#jupyter-widget-options).",
      },
      { iface: "CommApi", file: COMM, prefix: "jupyter.comm.", heading: "jupyter.comm" },
      { iface: "Comm", file: COMM, prefix: "comm.", heading: "Comm" },
    ],
    types: [
      { name: "WidgetOptions", file: WIDGET },
      { name: "CommMessage", file: COMM },
      { name: "CommSendOptions", file: COMM },
    ],
  },
];

interface Doc {
  summary: string;
  params: Map<string, string>;
  returns?: string;
  throws: { type: string; text: string }[];
  availability?: string;
  examples: string[];
  see?: string;
}

export interface Example {
  where: string;
  code: string;
}

export interface Result {
  files: Map<string, string>;
  problems: string[];
  examples: Example[];
}

function text(comment: string | ts.NodeArray<ts.JSDocComment> | undefined): string {
  return (ts.getTextOfJSDocComment(comment) ?? "").trim();
}

/** One paragraph: the wrapped lines of a tag joined with spaces. */
function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim();
}

function readDoc(node: ts.Node): Doc | undefined {
  const jsDoc = (node as { jsDoc?: ts.JSDoc[] }).jsDoc?.at(-1);
  if (!jsDoc) return;
  const doc: Doc = { summary: text(jsDoc.comment), params: new Map(), throws: [], examples: [] };
  for (const tag of jsDoc.tags ?? []) {
    const body = text(tag.comment);
    if (ts.isJSDocParameterTag(tag)) doc.params.set(tag.name.getText(), oneLine(body));
    else if (ts.isJSDocReturnTag(tag)) doc.returns = oneLine(body);
    else if (ts.isJSDocThrowsTag(tag)) {
      doc.throws.push({ type: tag.typeExpression?.type.getText() ?? "Error", text: oneLine(body) });
    } else if (tag.tagName.text === "availability") doc.availability = oneLine(body);
    else if (tag.tagName.text === "example") doc.examples.push(body);
    else if (ts.isJSDocSeeTag(tag)) {
      // `@see page.md#anchor`: TS reads the page as a name reference.
      doc.see = `${tag.name?.getText() ?? ""}${body}`.replace(/\s+/g, "");
    }
  }
  return doc;
}

function memberName(m: ts.TypeElement): string | undefined {
  if (!m.name || ts.isComputedPropertyName(m.name)) return;
  return m.name.getText();
}

/** `display(obj, options?)` from a signature's parameters. */
function callShape(sig: ts.SignatureDeclarationBase): string {
  return sig.parameters
    .map((p) => `${p.dotDotDotToken ? "..." : ""}${p.name.getText()}${p.questionToken ? "?" : ""}`)
    .join(", ");
}

function isTemplateTag(sig: ts.SignatureDeclarationBase): boolean {
  return sig.parameters[0]?.type?.getText() === "TemplateStringsArray";
}


/** VitePress's heading slug (vitepress/dist/node: slugify) of a heading's text. */
export function slugify(heading: string): string {
  return heading
    .replace(/`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .normalize("NFKD")
    .replace(/[\u0300-\u036F]/g, "")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^(\d)/, "_$1")
    .toLowerCase();
}


/** Inline code, with double backticks when the text has one. */
function code(s: string): string {
  return s.includes("`") ? `\`\` ${s} \`\`` : `\`${s}\``;
}

/** A declaration's source, without the indentation of the lines after the first. */
function source(node: ts.Node, sf: ts.SourceFile): string {
  const { character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return node.getText(sf).replace(new RegExp(`\n {${character}}`, "g"), "\n");
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * "Guide: [its title](page#anchor)", taking the title from the guide's
 * first heading. A problem if the page or the anchor doesn't exist.
 */
function seeLink(see: string, where: string, r: Result): string {
  const [page, hash] = see.split("#");
  let text = "";
  try {
    text = readFileSync(join(root, "docs", page), "utf8");
  } catch {
    r.problems.push(`${where}: @see ${page} doesn't exist`);
  }
  const headings = [...text.matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1]);
  const ids = new Set([...headings.map(slugify), ...[...text.matchAll(/<a id="([^"]+)">/g)].map((m) => m[1])]);
  if (text && hash && !ids.has(hash)) r.problems.push(`${where}: @see ${see}: ${page} has no heading #${hash}`);
  return `Guide: [${headings[0] ?? page}](${see})`;
}

function renderDoc(out: string[], doc: Doc, sigs: ts.SignatureDeclarationBase[] | undefined, where: string, r: Result) {
  out.push(doc.summary, "");
  if (sigs) {
    const params = new Map<string, ts.ParameterDeclaration>();
    for (const sig of sigs) for (const p of sig.parameters) if (!params.has(p.name.getText())) params.set(p.name.getText(), p);
    for (const name of doc.params.keys()) {
      if (!params.has(name)) r.problems.push(`${where}: @param ${name} names no parameter`);
    }
    const shown = [...params.values()].filter((p) => !(isTemplateTag(sigs[0]) && sigs[0].parameters.includes(p)));
    if (shown.length > 0) {
      out.push("| Parameter | Type | Required | Description |", "| --- | --- | --- | --- |");
      for (const p of shown) {
        const name = p.name.getText();
        const desc = doc.params.get(name);
        if (!desc) r.problems.push(`${where}: parameter ${name} has no @param`);
        const optional = p.questionToken !== undefined || sigs.some((s) => !s.parameters.some((q) => q.name.getText() === name));
        const types = new Set(sigs.flatMap((s) => s.parameters.filter((q) => q.name.getText() === name).map((q) => q.type?.getText() ?? "unknown")));
        const type = types.size === 1 ? `\`${cell([...types][0])}\`` : "depends on the overload: see the signatures";
        out.push(`| \`${name}\` | ${type} | ${optional ? "no" : "yes"} | ${cell(desc ?? "")} |`);
      }
      out.push("");
    }
    const type = sigs[0].type?.getText();
    if (type && type !== "void") out.push(`**Returns** \`${cell(type)}\`${doc.returns ? `: ${doc.returns}` : ""}`, "");
  }
  for (const t of doc.throws) out.push(`**Throws** \`${t.type}\`: ${t.text}`, "");
  if (doc.availability) out.push(`**Availability**: ${doc.availability}`, "");
  for (const example of doc.examples) {
    // A ```ts block, then optionally screenshots of its output.
    const m = /^```ts\n([\s\S]*?)\n```((?:\n!\[[^\]]+\]\([^)]+\))*)$/.exec(example);
    if (!m) {
      r.problems.push(`${where}: an @example is not a \`\`\`ts block, optionally followed by images`);
      continue;
    }
    r.examples.push({ where, code: m[1] });
    out.push("```ts", m[1], "```", "");
    for (const [, alt, url] of m[2].matchAll(/!\[([^\]]+)\]\(([^)]+)\)/g)) {
      // Hovers need an absolute URL; the pages use the copy in docs/images/.
      if (!url.startsWith(IMAGES)) {
        r.problems.push(`${where}: image ${url} is not under ${IMAGES}`);
        continue;
      }
      const file = `images/${url.slice(IMAGES.length)}`;
      if (!existsSync(join(root, "docs", file))) r.problems.push(`${where}: docs/${file} doesn't exist`);
      // The guide's examples are what `npm run docs:widgets` screenshots,
      // so an example shown with one must be the guide's code, verbatim.
      if (file.startsWith("images/widgets/") && !readFileSync(join(root, "docs", "widgets.md"), "utf8").includes(`\`\`\`ts\n${m[1]}\n\`\`\``)) {
        r.problems.push(`${where}: the example shown with ${file} is not one of widgets.md's examples`);
      }
      out.push(`![${alt}](${file})`, "");
    }
  }
  if (doc.see) out.push(seeLink(doc.see, where, r), "");
}

function renderSection(out: string[], index: string[], section: Section, sf: ts.SourceFile, r: Result) {
  const decl = sf.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === section.iface);
  if (!decl) {
    r.problems.push(`${section.file}: no interface ${section.iface}`);
    return;
  }
  const heading = section.heading.includes(" ") ? section.heading : code(section.heading);
  out.push(`## ${heading}`, "");
  const ifaceDoc = readDoc(decl);
  if (ifaceDoc?.summary) out.push(ifaceDoc.summary, "");
  if (section.intro) out.push(section.intro, "");

  // Members by name, keeping overloads together, in declaration order.
  const byName = new Map<string, ts.TypeElement[]>();
  for (const m of decl.members) {
    const name = memberName(m);
    if (name) byName.set(name, [...(byName.get(name) ?? []), m]);
  }
  // Plain properties without examples go in one table; the rest get headings.
  const props: string[] = [];
  for (const [name, members] of byName) {
    const first = members[0];
    const doc = members.map(readDoc).find((d) => d?.summary);
    const where = `${section.iface}.${name}`;
    if (!doc) {
      r.problems.push(`${where}: no doc comment`);
      continue;
    }
    const sigs = members.filter(ts.isMethodSignature);
    if (sigs.length === 0 && doc.examples.length === 0 && !doc.see) {
      const p = first as ts.PropertySignature;
      props.push(`| \`${name}\` | \`${cell(p.type?.getText() ?? "")}\` | ${cell(oneLine(doc.summary))} |`);
      continue;
    }
    const full = `${section.prefix}${name}`;
    const title = sigs.length === 0 ? full : isTemplateTag(sigs[0]) ? `${full}\`…\`` : `${full}(${callShape(sigs[0])})`;
    const id = slugify(code(title));
    index.push(`| [${code(title)}](#${id}) | ${cell(oneLine(doc.summary.split(/(?<=\.)\s/)[0]))} |`);
    out.push(`### ${code(title)}`, "");
    out.push("```ts", ...members.map((m) => source(m, sf)), "```", "");
    if (sigs.length > 0 && doc.examples.length === 0) r.problems.push(`${where}: no @example`);
    renderDoc(out, doc, sigs.length > 0 ? sigs : undefined, where, r);
  }
  if (props.length > 0) {
    out.push("### Properties", "", "| Property | Type | Description |", "| --- | --- | --- |", ...props, "");
  }
}

function renderGlobal(out: string[], index: string[], name: string, sf: ts.SourceFile, r: Result) {
  let fn: ts.FunctionDeclaration | undefined;
  sf.forEachChild(function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) fn = node;
    else node.forEachChild(visit);
  });
  const doc = fn && readDoc(fn);
  if (!fn || !doc) {
    r.problems.push(`${GLOBALS}: global ${name} is missing or undocumented`);
    return;
  }
  const title = `${name}(${callShape(fn)})`;
  index.push(`| [\`${title}\`](#${slugify(title)}) | ${cell(oneLine(doc.summary.split(/(?<=\.)\s/)[0]))} |`);
  out.push(`### \`${title}\``, "");
  out.push("```ts", `function ${fn.getText(sf).replace(/^function\s+/, "")}`, "```", "");
  if (doc.examples.length === 0) r.problems.push(`${name}: no @example`);
  renderDoc(out, doc, [fn], name, r);
}

function renderType(out: string[], name: string, sf: ts.SourceFile, r: Result) {
  const decl = sf.statements.find(
    (s): s is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
      (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) && s.name.text === name,
  );
  const doc = decl && readDoc(decl);
  if (!decl || !doc?.summary) {
    r.problems.push(`type ${name} is missing or undocumented`);
    return;
  }
  out.push(`### \`${name}\``, "", doc.summary, "");
  if (ts.isTypeAliasDeclaration(decl)) {
    out.push("```ts", decl.getText(sf), "```", "");
    return;
  }
  out.push("| Property | Type | Required | Description |", "| --- | --- | --- | --- |");
  for (const m of decl.members) {
    const p = m as ts.PropertySignature;
    // A computed key is the `$display` symbol, which cells reach as `jupyter.$display`.
    const key = m.name?.getText(sf).replace(/^\[\$display\]$/, "[jupyter.$display]");
    const desc = readDoc(m)?.summary;
    if (!desc) r.problems.push(`${name}.${key}: no doc comment`);
    const type = ts.isMethodSignature(m) ? `() => ${m.type?.getText(sf)}` : (p.type?.getText(sf) ?? "");
    out.push(`| \`${key}\` | \`${cell(type)}\` | ${p.questionToken ? "no" : "yes"} | ${cell(oneLine(desc ?? ""))} |`);
  }
  out.push("");
}

export function generate(): Result {
  const r: Result = { files: new Map(), problems: [], examples: [] };
  const files = new Map<string, ts.SourceFile>();
  const source = (file: string) => {
    let sf = files.get(file);
    if (!sf) {
      sf = ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
      files.set(file, sf);
    }
    return sf;
  };
  for (const page of pages) {
    const body: string[] = [];
    const index: string[] = [];
    for (const section of page.sections) renderSection(body, index, section, source(section.file), r);
    if (page.globals) {
      body.push("## Globals", "");
      for (const name of page.globals) renderGlobal(body, index, name, source(GLOBALS), r);
    }
    body.push("## Types", "");
    for (const t of page.types) renderType(body, t.name, source(t.file), r);
    // Links and the outline use VitePress's heading slugs, so a member's
    // must be unique on its page ("Properties" repeats, and isn't linked).
    const slugs = body.filter((l) => /^#{2,3} /.test(l) && l !== "### Properties").map((l) => slugify(l.replace(/^#+ /, "")));
    for (const slug of new Set(slugs.filter((s, i) => slugs.indexOf(s) !== i))) {
      r.problems.push(`${page.file}: two headings have the slug #${slug}`);
    }
    const out = [
      `<!-- Generated by scripts/reference.ts from the doc comments in ${[...new Set([...page.sections.map((s) => s.file), ...(page.globals ? [GLOBALS] : []), ...page.types.map((t) => t.file)])].join(", ")}. Edit those, then run \`node scripts/reference.ts --write\`. -->`,
      "",
      `# ${page.title}`,
      "",
      page.intro,
      "",
      "| Member | What it does |",
      "| --- | --- |",
      ...index,
      "",
      ...body,
    ];
    r.files.set(page.file, `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`);
  }
  return r;
}

/** Pages on disk that differ from what the doc comments generate. */
export function stale(r: Result): string[] {
  return [...r.files].filter(([file, content]) => {
    try {
      return readFileSync(join(root, file), "utf8") !== content;
    } catch {
      return true;
    }
  }).map(([file]) => file);
}

if (import.meta.main) {
  const r = generate();
  for (const p of r.problems) console.error(p);
  if (process.argv.includes("--write")) {
    for (const [file, content] of r.files) writeFileSync(join(root, file), content);
  } else {
    const files = stale(r);
    for (const file of files) console.error(`${file} is out of date: run node scripts/reference.ts --write`);
    if (files.length > 0) process.exitCode = 1;
  }
  if (r.problems.length > 0) process.exitCode = 1;
}
