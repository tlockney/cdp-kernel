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
//
// An example written as ```ts cell runs when the docs' notebooks are built
// (npm run docs:notebooks), and the site shows its output under it: the
// page names its notebook (Page.notebook), and docs/.vitepress/notebook.ts
// matches each such block to a cell.

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
  /** A heading id other than the heading's slug, kept when a heading is reworded. */
  id?: string;
  intro?: string;
  /**
   * Members under group headings, in this order. When set, every member
   * is in exactly one group.
   */
  groups?: Group[];
}

/** A heading over related members of one section. */
interface Group {
  heading: string;
  intro?: string;
  members: string[];
}

/** A heading over the sections after it, up to the next part. */
interface Part {
  part: string;
  intro: string;
}

interface Page {
  file: string;
  title: string;
  intro: string;
  /**
   * With an overview, the page opens with an Overview section: this text,
   * then a member table per section. Without, one table for the page.
   */
  overview?: string;
  sections: (Section | Part)[];
  /** Global functions declared in src/globals.ts. */
  globals?: string[];
  /** Option and value types, as property tables. */
  types: { name: string; file: string }[];
  /**
   * The index at the top, split into tables by topic. A member belongs to
   * the first group with a name that is its own or a prefix of it
   * (`jupyter.sql` takes `jupyter.sql.query`), and the tables list members
   * in the order of `members`. Without groups, one table in page order.
   */
  groups?: { title: string; members: string[] }[];
  /**
   * The notebook the page's ```ts cell examples run in, under docs/:
   * the page names it in a <!-- notebook: --> comment.
   */
  notebook?: string;
}

/** A row of a page's index, and the member name it is filed under. */
interface IndexRow {
  name: string;
  row: string;
}

/** Where the site publishes docs/images/ (pages.yml), for images in doc comments. */
const IMAGES = "https://cdp-kernel.org/images/";

const DISPLAY = "runtime/display.d.mts";
const COMM = "runtime/comm.d.mts";
const WIDGET = "runtime/widget.d.mts";
const HOST = "runtime/host.d.mts";
const SQL = "runtime/sql.d.mts";
const GLOBALS = "src/globals.ts";

export const pages: Page[] = [
  {
    file: "docs/jupyter-reference.md",
    title: "`jupyter` reference",
    intro: `Every member of the \`jupyter\` global and the \`prompt\` and \`confirm\`
globals, with their arguments, return values and an example. Examples
that can run on their own show the output they produced. [The
\`jupyter\` namespace](jupyter-api.md) explains the members with longer
examples. Widgets and comms are in the [widgets
reference](widgets-reference.md).`,
    notebook: "public/notebooks/jupyter-reference.ipynb",
    sections: [
      { iface: "JupyterNamespace", file: DISPLAY, prefix: "jupyter.", heading: "jupyter" },
      {
        iface: "Sql",
        file: SQL,
        prefix: "jupyter.sql.",
        heading: "Sql",
        intro: "Methods of [`jupyter.sql`](#jupyter-sql), beside the tag itself.",
      },
      {
        iface: "Host",
        file: HOST,
        prefix: "host.",
        heading: "Host",
        intro: "`await jupyter.host()` returns it; see [`jupyter.host`](#jupyter-host-options).",
      },
      { iface: "HostNotebooks", file: HOST, prefix: "host.notebooks.", heading: "host.notebooks" },
      { iface: "HostSelf", file: HOST, prefix: "host.self.", heading: "host.self" },
    ],
    globals: ["prompt", "confirm"],
    types: [
      { name: "DisplayOptions", file: DISPLAY },
      { name: "HostOptions", file: HOST },
      { name: "HostCallOptions", file: HOST },
      { name: "PromptOptions", file: GLOBALS },
      { name: "MediaBundle", file: DISPLAY },
      { name: "Displayable", file: DISPLAY },
    ],
    groups: [
      {
        title: "Showing output",
        members: ["jupyter.display", "jupyter.md", "jupyter.html", "jupyter.svg", "jupyter.image", "jupyter.$display", "jupyter.format", "jupyter.broadcast"],
      },
      { title: "Data", members: ["jupyter.table", "jupyter.sql", "jupyter.chart"] },
      { title: "Asking and interrupting", members: ["prompt", "confirm", "jupyter.signal", "jupyter.comm", "jupyter.widget"] },
      { title: "Notebooks as programs", members: ["jupyter.params", "jupyter.result", "jupyter.host", "host"] },
    ],
  },
  {
    file: "docs/widgets-reference.md",
    title: "Widgets and comms reference",
    intro: `The widget model that \`jupyter.widget(options)\` returns, and the comm
API under \`jupyter.comm\`, with their arguments, return values and an
example. [Widgets and comms](widgets.md) explains them with a full
walk-through, including the view module.`,
    overview: `A **widget** is an [anywidget](https://anywidget.dev) model: state that
the kernel and its views share, and a view module that draws it. Use one
for interactive output: controls, progress, a chart that updates.

A **comm** is the channel widgets are built on: messages both ways on a
target name, with no shared state and no view. Use one to talk to a
frontend extension that registered a target.`,
    sections: [
      {
        iface: "Widget",
        file: WIDGET,
        prefix: "widget.",
        heading: "Widget model",
        intro: "`jupyter.widget(options)` returns it; see the [`jupyter` reference](jupyter-reference.md#jupyter-widget-options).",
        groups: [
          { heading: "State", intro: "The synced state, read and changed from the kernel.", members: ["get", "set", "fullState"] },
          { heading: "Events", intro: "State changes and custom messages from the views.", members: ["on", "off"] },
          { heading: "Custom messages", intro: "Messages to the views that aren't state; `on(\"msg:custom\", ...)` receives theirs.", members: ["send"] },
          { heading: "Closing", members: ["close"] },
        ],
      },
      {
        part: "Comms",
        intro: "`jupyter.comm` opens comms and accepts the ones the frontend opens; each is a `Comm` object.",
      },
      { iface: "CommApi", file: COMM, prefix: "jupyter.comm.", heading: "jupyter.comm" },
      { iface: "Comm", file: COMM, prefix: "comm.", heading: "`Comm` object", id: "comm" },
    ],
    groups: [
      { title: "[Widget model](#widget-model)", members: ["widget"] },
      { title: "[Comms](#comms)", members: ["jupyter.comm", "comm"] },
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
 * A Markdown page's first heading and the ids VitePress gives its
 * headings: slugs, with -1, -2 on repeats, or a `{#id}`, plus `<a id>`
 * anchors. Headings inside fenced code don't count, including indented
 * fences (in a list item) and fences of four or more backticks.
 */
export function anchors(markdown: string): { title?: string; ids: Set<string> } {
  const prose = markdown.replace(/^ *(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ *\1[`~]*[ \t]*$/gm, "");
  const headings = [...prose.matchAll(/^#{1,6} (.+?)(?: \{#([^}]+)\})?$/gm)];
  const ids = new Set([...prose.matchAll(/<a id="([^"]+)">/g)].map((m) => m[1]));
  const seen = new Map<string, number>();
  for (const [, title, custom] of headings) {
    const slug = custom ?? slugify(title);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    ids.add(n === 0 ? slug : `${slug}-${n}`);
  }
  return { title: headings[0]?.[1], ids };
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
  const { title, ids } = anchors(text);
  if (text && hash && !ids.has(hash)) r.problems.push(`${where}: @see ${see}: ${page} has no heading #${hash}`);
  return `Guide: [${title ?? page}](${see})`;
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
    // Not cell(): outside a table, a `\|` in a code span shows the backslash.
    if (type && type !== "void") out.push(`**Returns** \`${oneLine(type)}\`${doc.returns ? `: ${doc.returns}` : ""}`, "");
  }
  for (const t of doc.throws) out.push(`**Throws** \`${t.type}\`: ${t.text}`, "");
  if (doc.availability) out.push(`**Availability**: ${doc.availability}`, "");
  for (const example of doc.examples) {
    // A ```ts block, then optionally screenshots of its output.
    const m = /^```ts( cell)?\n([\s\S]*?)\n```((?:\n!\[[^\]]+\]\([^)]+\))*)$/.exec(example);
    if (!m) {
      r.problems.push(`${where}: an @example is not a \`\`\`ts block, optionally followed by images`);
      continue;
    }
    const [, runs, code, images] = m;
    r.examples.push({ where, code });
    out.push(`\`\`\`ts${runs ?? ""}`, code, "```", "");
    for (const [, alt, url] of images.matchAll(/!\[([^\]]+)\]\(([^)]+)\)/g)) {
      // Hovers need an absolute URL; the pages use the copy in docs/images/.
      if (!url.startsWith(IMAGES)) {
        r.problems.push(`${where}: image ${url} is not under ${IMAGES}`);
        continue;
      }
      const file = `images/${url.slice(IMAGES.length)}`;
      if (!existsSync(join(root, "docs", file))) r.problems.push(`${where}: docs/${file} doesn't exist`);
      // The guide's examples are what `npm run docs:widgets` screenshots,
      // so an example shown with one must be the guide's code, verbatim.
      if (file.startsWith("images/widgets/") && !readFileSync(join(root, "docs", "widgets.md"), "utf8").includes(`\n${code}\n\`\`\``)) {
        r.problems.push(`${where}: the example shown with ${file} is not one of widgets.md's examples`);
      }
      out.push(`![${alt}](${file})`, "");
    }
  }
  if (doc.see) out.push(seeLink(doc.see, where, r), "");
}

/** A heading of `level` (2 is `##`), with its id when it isn't the slug. */
function heading(level: number, text: string, id?: string): string {
  return `${"#".repeat(level)} ${text}${id ? ` {#${id}}` : ""}`;
}

/**
 * Members by name, overloads together: in group order when the section
 * has groups (with each group's heading before its first member), else
 * in declaration order. Members in no group come last, flagged: only
 * plain properties, which go in the Properties table, may be.
 */
function ordered(
  section: Section,
  byName: Map<string, ts.TypeElement[]>,
  r: Result,
): { name: string; group?: Group; ungrouped?: boolean }[] {
  if (!section.groups) return [...byName.keys()].map((name) => ({ name }));
  const out: { name: string; group?: Group; ungrouped?: boolean }[] = [];
  for (const group of section.groups) {
    for (const [n, name] of group.members.entries()) {
      if (!byName.has(name)) r.problems.push(`${section.iface}: group "${group.heading}" names no member ${name}`);
      else out.push({ name, group: n === 0 ? group : undefined });
    }
  }
  const grouped = section.groups.flatMap((g) => g.members);
  for (const name of byName.keys()) {
    if (!grouped.includes(name)) out.push({ name, ungrouped: true });
    else if (grouped.indexOf(name) !== grouped.lastIndexOf(name)) r.problems.push(`${section.iface}.${name}: in two groups`);
  }
  return out;
}

function renderSection(out: string[], index: IndexRow[], section: Section, sf: ts.SourceFile, r: Result, level = 2) {
  const decl = sf.statements.find((s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === section.iface);
  if (!decl) {
    r.problems.push(`${section.file}: no interface ${section.iface}`);
    return;
  }
  const sectionTitle = section.heading.includes(" ") ? section.heading : code(section.heading);
  out.push(heading(level, sectionTitle, section.id), "");
  const ifaceDoc = readDoc(decl);
  if (ifaceDoc?.summary) out.push(ifaceDoc.summary, "");
  if (section.intro) out.push(section.intro, "");

  // Members by name, keeping overloads together, in declaration order.
  const byName = new Map<string, ts.TypeElement[]>();
  for (const m of decl.members) {
    const name = memberName(m);
    if (name) byName.set(name, [...(byName.get(name) ?? []), m]);
    // A symbol-keyed member has no heading, but still needs a doc comment.
    else if (!readDoc(m)?.summary) r.problems.push(`${section.iface}.${m.name?.getText(sf) ?? "(a signature)"}: no doc comment`);
  }
  // Plain properties without examples go in one table; the rest get headings.
  const props: string[] = [];
  const memberLevel = level + (section.groups ? 2 : 1);
  for (const { name, group, ungrouped } of ordered(section, byName, r)) {
    const members = byName.get(name)!;
    if (group) {
      out.push(heading(level + 1, group.heading), "");
      if (group.intro) out.push(group.intro, "");
    }
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
    if (ungrouped) r.problems.push(`${where}: in no group`);
    const full = `${section.prefix}${name}`;
    const title = sigs.length === 0 ? full : isTemplateTag(sigs[0]) ? `${full}\`…\`` : `${full}(${callShape(sigs[0])})`;
    const id = slugify(code(title));
    index.push({ name: full, row: `| [${code(title)}](#${id}) | ${cell(oneLine(doc.summary.split(/(?<=\.)\s/)[0]))} |` });
    out.push(heading(memberLevel, code(title)), "");
    out.push("```ts", ...members.map((m) => source(m, sf)), "```", "");
    if (sigs.length > 0 && doc.examples.length === 0) r.problems.push(`${where}: no @example`);
    renderDoc(out, doc, sigs.length > 0 ? sigs : undefined, where, r);
  }
  if (props.length > 0) {
    out.push(heading(level + 1, "Properties"), "", "| Property | Type | Description |", "| --- | --- | --- |", ...props, "");
  }
}

function renderGlobal(out: string[], index: IndexRow[], name: string, sf: ts.SourceFile, r: Result) {
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
  index.push({ name, row: `| [\`${title}\`](#${slugify(title)}) | ${cell(oneLine(doc.summary.split(/(?<=\.)\s/)[0]))} |` });
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

const TABLE_HEAD = ["| Member | What it does |", "| --- | --- |"];

function renderIndex(page: Page, index: IndexRow[], r: Result): string[] {
  if (!page.groups) return [...TABLE_HEAD, ...index.map((i) => i.row), ""];
  const groups = page.groups;
  // Where a name is filed: its group, and its place among that group's members.
  const place = (name: string) => {
    for (const [g, group] of groups.entries()) {
      const m = group.members.findIndex((p) => name === p || name.startsWith(`${p}.`));
      if (m >= 0) return { g, m };
    }
    return undefined;
  };
  const out: string[] = [];
  for (const i of index) if (!place(i.name)) r.problems.push(`${page.file}: ${i.name} is in no group`);
  for (const [g, group] of groups.entries()) {
    const rows = index
      .map((i, n) => ({ ...i, n, at: place(i.name) }))
      .filter((i) => i.at?.g === g)
      .sort((a, b) => a.at!.m - b.at!.m || a.n - b.n);
    if (rows.length === 0) r.problems.push(`${page.file}: group "${group.title}" has no members`);
    out.push(`**${group.title}**`, "", ...TABLE_HEAD, ...rows.map((i) => i.row), "");
  }
  return out;
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
    const index: IndexRow[] = [];
    let level = 2;
    for (const section of page.sections) {
      if ("part" in section) {
        body.push(heading(2, section.part), "", section.intro, "");
        level = 3;
      } else renderSection(body, index, section, source(section.file), r, level);
    }
    if (page.globals) {
      body.push("## Globals", "");
      for (const name of page.globals) renderGlobal(body, index, name, source(GLOBALS), r);
    }
    body.push("## Types", "");
    for (const t of page.types) renderType(body, t.name, source(t.file), r);
    if (!page.notebook && body.includes("```ts cell")) {
      r.problems.push(`${page.file}: has \`ts cell\` examples but no notebook`);
    }
    // Links and the outline use VitePress's heading slugs, so a member's
    // must be unique on its page ("Properties" repeats, and isn't linked).
    const slugs = body
      .map((l) => /^#{2,6} (.+?)(?: \{#([^}]+)\})?$/.exec(l))
      .filter((m) => m && m[1] !== "Properties")
      .map((m) => m![2] ?? slugify(m![1]));
    for (const slug of new Set(slugs.filter((s, i) => slugs.indexOf(s) !== i))) {
      r.problems.push(`${page.file}: two headings have the slug #${slug}`);
    }
    // The outline shows h2 and h3 (config.mts); a page with group
    // headings has its members at h4, so its outline goes a level deeper.
    const deep = body.some((l) => l.startsWith("#### ") && l !== "#### Properties");
    const out = [
      ...(deep ? ["---", "outline: [2, 4]", "---", ""] : []),
      `<!-- Generated by scripts/reference.ts from the doc comments in ${[...new Set([...page.sections.flatMap((s) => ("file" in s ? [s.file] : [])), ...(page.globals ? [GLOBALS] : []), ...page.types.map((t) => t.file)])].join(", ")}. Edit those, then run \`node scripts/reference.ts --write\`. -->`,
      "",
      `# ${page.title}`,
      "",
      page.intro,
      "",
      ...(page.notebook ? [`<!-- notebook: ${page.notebook} -->`, ""] : []),
      ...(page.overview ? ["## Overview", "", page.overview, ""] : []),
      ...renderIndex(page, index, r),
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
