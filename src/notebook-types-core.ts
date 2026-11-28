// TypeScript's language service over a notebook (#263): completion from
// declared types, where the runtime only knows values. Runs in a worker
// (src/language-service-worker.ts; src/browser/language-worker.ts in a page)
// and see probes/ts-language-service.md for the design and its measurements.
//
// This file has no Node imports, so a browser bundle can take it (#524): the
// file system, path join and npm cache lookup come in through the options,
// and src/notebook-types.ts supplies Node's.
//
// The service sees one virtual file, never written to disk, in the
// notebook's directory (so relative imports resolve from there): the cells
// executed so far, then the cell being edited. REPL cells redeclare names
// all the time (`const x = 1`, later `const x = "s"`), which in one file is
// an error that keeps the first type, so a declaration is dropped from the
// history when a later cell, or the one being edited, declares all of its
// names again.

import type TS from "typescript";
import type { DenoResolver } from "./deno-types.ts";

export interface NotebookTypesOptions {
  notebookDir: string;
  /**
   * The installer cache npm: and jsr: imports resolve from: where the
   * target installs them (Bun's own for Bun, npm's for the rest). Null for
   * Deno targets, which resolve them natively (see `deno`).
   */
  npmCache: "npm" | "bun" | null;
  /**
   * For Deno targets: where Deno put what the executed cells imported
   * (npm:, jsr:, URLs, the project's import map).
   */
  deno?: DenoResolver;
  /** compilerOptions.types: type packages found from the notebook's directory. */
  types: string[];
  /** Declaration files every cell sees, e.g. runtime types. */
  typeFiles: string[];
  /** Declarations for the kernel's own globals (jupyter, prompt, confirm). */
  globals: string;
}

/**
 * The files the service reads (#524): ts.sys's on Node, a map of
 * fetched files in a page. Paths are absolute and use `/`.
 */
export interface TypesFileSystem {
  readFile(path: string): string | undefined;
  fileExists(path: string): boolean;
  directoryExists(path: string): boolean;
  getDirectories(path: string): string[];
  realpath?(path: string): string;
  /** Without it, no directory lists any file (as for a notebook with no tsconfig). */
  readDirectory?(path: string, extensions?: readonly string[], exclude?: readonly string[], include?: readonly string[], depth?: number): string[];
}

/** An installed npm: or jsr: package, as installedPackageDir reports it, and the subpath imported. */
export interface CachedPackage {
  dir: string;
  alias: string;
  subpath: string;
}

/** What NotebookTypesCore needs besides NotebookTypesOptions (#524). */
export interface NotebookTypesHost {
  fs: TypesFileSystem;
  join(...parts: string[]): string;
  /** Where an npm: or jsr: import is installed, if it is; only asked when `npmCache` isn't null. */
  cachedPackage?(specifier: string): CachedPackage | null;
  /** Where the lib files are; without it, next to the TypeScript module (ts.getDefaultLibFilePath). */
  libDir?: string;
  /** compilerOptions.lib; lib.esnext.d.ts by default. */
  lib?: string[];
  /** Called once per newly seen import specifier in executed or checked cells (#525). */
  onImportSpecifiers?: (specifiers: readonly string[]) => void;
}

/** A path made of `parts`, joined with `/` and with `.` and `..` resolved. */
export function posixJoin(...parts: string[]): string {
  const absolute = parts[0]?.startsWith("/") ?? false;
  const out: string[] = [];
  for (const part of parts.join("/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else if (part !== ".." || !absolute) out.push(part);
  }
  return (absolute ? "/" : "") + out.join("/");
}

export interface CompletionEntry {
  name: string;
  /** TypeScript's ScriptElementKind: "method", "property", "const", ... */
  kind: string;
}

export interface CompletionResult {
  /** Where the completed name starts in the cell, as a UTF-16 index. */
  start: number;
  entries: CompletionEntry[];
}

/** A type or syntax error in the cell being checked (#514). */
export interface CellDiagnostic {
  /** Where it starts and ends in the cell, as UTF-16 indices. */
  start: number;
  end: number;
  severity: "error" | "warning";
  /** TypeScript's diagnostic code, e.g. 2322. */
  code: number;
  message: string;
}

/** What a signature help popup shows for the call at the cursor (#522). */
export interface SignatureHelp {
  /** The whole signature, e.g. `add(a: number, b: number): number`. */
  label: string;
  documentation: string;
  parameters: { label: string; documentation: string }[];
  /**
   * The parameter the cursor's argument is for, as TypeScript counts it:
   * it stays on a rest parameter, and is past the last parameter when the
   * call has more arguments than the signature has.
   */
  activeParameter: number;
}

/** A span in one of the notebook's cells, as UTF-16 indices in that cell (#522). */
export interface CellSpan {
  /** Index into the cells the request listed. */
  cell: number;
  start: number;
  end: number;
}

/** Text that replaces a span of a cell (#522). */
export interface CellEdit extends CellSpan {
  text: string;
}

/** A rename's edits, or why the name can't be renamed. */
export type RenameResult = { edits: CellEdit[] } | { error: string };

/**
 * Errors that notebook rules make false, by TypeScript code: they are
 * kept only when the name or module they are about isn't one of these
 * cases (see #ignored).
 */
const REDECLARATION = new Set([
  2300, // Duplicate identifier 'x'.
  2323, // Cannot redeclare exported variable 'x'.
  2393, // Duplicate function implementation.
  2403, // Subsequent variable declarations must have the same type.
  2440, // Import declaration conflicts with local declaration of 'x'.
  2451, // Cannot redeclare block-scoped variable 'x'.
  2567, // Enum declarations can only merge with namespace or other enum declarations.
]);
const MODULE_NOT_FOUND = new Set([
  2307, // Cannot find module 'x' or its corresponding type declarations.
  2792, // Cannot find module 'x'. Did you mean to set the 'moduleResolution' option ...?
]);
/** Could not find a declaration file for module 'x' (an npm: package without types). */
const UNTYPED_MODULE = 7016;

/** A name a declaration can have (#522), apart from the reserved words. */
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u;
const RESERVED = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum", "export",
  "extends", "false", "finally", "for", "function", "if", "implements", "import", "in", "instanceof", "interface", "let", "new", "null",
  "package", "private", "protected", "public", "return", "static", "super", "switch", "this", "throw", "true", "try", "typeof", "var",
  "void", "while", "with", "yield",
]);

/** The identifier the cursor (a UTF-16 index) is in or at the end of. */
function wordAt(code: string, cursor: number): string {
  return (/[\w$]*$/.exec(code.slice(0, cursor))?.[0] ?? "") + (/^[\w$]*/.exec(code.slice(cursor))?.[0] ?? "");
}

/**
 * Whether a cell up to `at` declares `name` again, after a statement that
 * declares it and other names too that no cell declares again: that
 * statement stays in the file (see NotebookTypes#withoutRedeclared), so the
 * name resolves to it and not to the nearest declaration.
 */
function partiallyRedeclared(cells: Cell[], name: string, at: number): boolean {
  const declaredIn = (n: string, after: number) => cells.some((c, i) => i > after && i <= at && c.statements.some((st) => st.names.includes(n)));
  return cells.some((c, j) =>
    j < at && c.statements.some((st) => st.names.length > 1 && st.names.includes(name) && declaredIn(name, j) && !st.names.every((n) => declaredIn(n, j)))
  );
}

/** The cell a span of the notebook file is in, as a span of that cell; null if it isn't inside one. */
export function cellSpan(starts: number[], texts: string[], start: number, length: number): CellSpan | null {
  const i = starts.findLastIndex((s) => s <= start);
  if (i < 0 || start + length > starts[i] + texts[i].length) return null;
  return { cell: i, start: start - starts[i], end: start - starts[i] + length };
}

/** One top-level statement of an executed cell, and the names it declares. */
interface Statement {
  start: number;
  end: number;
  names: string[];
  /** Where each declared name is written in the cell (parallel to `names`). */
  spans: { start: number; end: number }[];
}

interface Cell {
  code: string;
  statements: Statement[];
}

// The document is a module, so top-level await in a cell isn't an error.
const PREFIX = "export {};\n";

export class NotebookTypesCore {
  readonly #ts: typeof TS;
  readonly #options: NotebookTypesOptions;
  readonly #hostOptions: NotebookTypesHost;
  readonly #join: (...parts: string[]) => string;
  readonly #file: string;
  readonly #globalsFile: string;
  readonly #service: TS.LanguageService;
  #compilerOptions: TS.CompilerOptions;
  #resolutionCache: TS.ModuleResolutionCache;
  /** ts.sys, plus the remote modules a Deno target fetched (virtual paths). */
  readonly #resolutionHost: TS.ModuleResolutionHost;
  readonly #cells: Cell[] = [];
  /** Specifiers executed cells imported: the target has fetched them. */
  readonly #imported = new Set<string>();
  /** Remote module specifiers resolved to virtual declaration files (#525). */
  readonly #remoteModules = new Map<string, string>();
  /** Specifiers already reported via `onImportSpecifiers`. */
  readonly #reportedSpecifiers = new Set<string>();
  /** Declaration files that exist only in memory, e.g. `deno types`. */
  readonly #virtualTypes = new Map<string, string>();
  #typeFiles: string[];
  #text = PREFIX;
  #version = 0;
  #projectVersion = 0;
  /** When a diagnostics check gives up (Date.now() ms); Infinity outside one. */
  #deadline = Infinity;

  constructor(ts: typeof TS, options: NotebookTypesOptions, host: NotebookTypesHost) {
    this.#ts = ts;
    this.#options = options;
    this.#hostOptions = host;
    this.#join = host.join;
    const fs = host.fs;
    this.#typeFiles = [...options.typeFiles];
    this.#file = this.#join(options.notebookDir, "__cdpk_notebook__.ts");
    this.#globalsFile = this.#join(options.notebookDir, "__cdpk_globals__.d.ts");
    this.#compilerOptions = {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      allowJs: true,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      lib: host.lib ?? ["lib.esnext.d.ts"],
      types: options.types,
    };
    const deno = options.deno;
    this.#resolutionHost = {
      getDirectories: (d) => fs.getDirectories(d),
      realpath: fs.realpath === undefined ? undefined : (f) => fs.realpath!(f),
      fileExists: (f) => deno?.localFile(f) !== undefined || fs.fileExists(f),
      readFile: (f) => {
        const local = deno?.localFile(f);
        return fs.readFile(local ?? f);
      },
      directoryExists: (d) => (deno !== undefined && d.startsWith(deno.root)) || fs.directoryExists(d),
      getCurrentDirectory: () => options.notebookDir,
    };
    const lsHost = this.#host();
    this.#resolutionCache = ts.createModuleResolutionCache(options.notebookDir, (f) => f, this.#compilerOptions);
    this.#service = ts.createLanguageService(lsHost, ts.createDocumentRegistry());
  }

  /** An executed cell: its declarations are in scope for later ones. */
  addCell(code: string): void {
    this.#cells.push({ code, statements: this.#statements(code) });
    const ts = this.#ts;
    const sf = ts.createSourceFile("cell.ts", code, ts.ScriptTarget.ESNext, false, ts.ScriptKind.TS);
    for (const stmt of sf.statements) {
      if ((ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        this.#imported.add(stmt.moduleSpecifier.text);
      }
    }
    this.#noteImports(code);
  }

  /** Registers a remote module specifier to resolve to a virtual declaration path (#525). */
  addResolvedModule(specifier: string, filePath: string): void {
    if (this.#remoteModules.get(specifier) === filePath) return;
    this.#remoteModules.set(specifier, filePath);
    // Earlier lookups cached a miss before the package types finished loading.
    this.#resolutionCache = this.#ts.createModuleResolutionCache(
      this.#options.notebookDir,
      (f) => f,
      this.#compilerOptions,
    );
    this.#projectVersion++;
  }

  /** The runtime restarted and lost its state. */
  reset(): void {
    this.#cells.length = 0;
  }

  /** Adds declaration files, e.g. runtime types installed after startup. */
  addTypeFiles(files: string[]): void {
    this.#typeFiles.push(...files.filter((f) => !this.#typeFiles.includes(f)));
    this.#projectVersion++;
  }

  /** Adds a declaration file held in memory, e.g. the output of `deno types`. */
  addVirtualTypeFile(name: string, text: string): void {
    this.#virtualTypes.set(this.#join(this.#options.notebookDir, name), text);
    this.#projectVersion++;
  }

  /** Adds type packages (compilerOptions.types) that resolve from the notebook. */
  addTypeNames(names: string[]): void {
    const current = this.#compilerOptions.types ?? [];
    // A new object: the service compares options by identity first.
    this.#compilerOptions = { ...this.#compilerOptions, types: [...current, ...names.filter((n) => !current.includes(n))] };
    this.#projectVersion++;
  }

  /** Whether a type package (compilerOptions.types) resolves from the notebook. */
  resolvesTypes(name: string): boolean {
    // Default type roots are found up from the current directory.
    const resolved = this.#ts.resolveTypeReferenceDirective(name, this.#file, this.#compilerOptions, this.#resolutionHost);
    return resolved.resolvedTypeReferenceDirective !== undefined;
  }

  /** Completions at `cursor` (a UTF-16 index) in `code`, the cell being edited. */
  complete(code: string, cursor: number): CompletionResult {
    const offset = this.#setDocument(code);
    const prefix = /[\w$]*$/.exec(code.slice(0, cursor))?.[0] ?? "";
    const info = this.#service.getCompletionsAtPosition(this.#file, offset + cursor, {
      includeCompletionsForModuleExports: false,
      includeCompletionsWithInsertText: true,
    });
    const ts = this.#ts;
    const entries = (info?.entries ?? [])
      .filter((e) =>
        e.kind !== ts.ScriptElementKind.keyword &&
        // Entries that would edit more than the name (`?.x`, `["a-b"]`).
        e.insertText === undefined && e.replacementSpan === undefined &&
        e.name.startsWith(prefix) && !e.name.startsWith("__cdpk")
      )
      .sort((a, b) => (a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((e) => ({ name: e.name, kind: e.kind }));
    return { start: cursor - prefix.length, entries };
  }

  /**
   * The type, signature and JSDoc of the name at `cursor`: the one the
   * cursor is in or just after, or, right after "name(", that callee.
   */
  quickInfo(code: string, cursor: number): string | null {
    const offset = this.#setDocument(code);
    const before = code.slice(0, cursor);
    const call = /[\w$]\(\s*$/.exec(before);
    // The name's last character when the cursor is just past it.
    const position = call ? call.index : /[\w$]/.test(code[cursor - 1] ?? "") ? cursor - 1 : cursor;
    const info = this.#service.getQuickInfoAtPosition(this.#file, offset + position);
    if (info === undefined) return null;
    const ts = this.#ts;
    // An imported name's "import x" line repeats the cell; alone, the import
    // didn't resolve. "any" alone is what an undeclared name gets, e.g. a
    // global a library set at runtime.
    const display = ts.displayPartsToString(info.displayParts).split("\n").filter((l) => !/^import [\w$]+$/.test(l)).join("\n");
    if (display === "" || display === "any") return null;
    const lines = [display];
    const docs = ts.displayPartsToString(info.documentation);
    if (docs !== "") lines.push(docs);
    for (const tag of info.tags ?? []) {
      const text = ts.displayPartsToString(tag.text);
      lines.push(`@${tag.name}${text === "" ? "" : ` ${text}`}`);
    }
    return lines.join("\n");
  }

  /**
   * Type and syntax errors in `code`, the cell being edited, checked
   * against the cells that ran (#514). Null when the check takes longer
   * than `budgetMs`. Errors that come from notebook rules (a name declared
   * again, an import that hasn't run yet) are left out.
   */
  diagnostics(code: string, budgetMs: number): CellDiagnostic[] | null {
    const ts = this.#ts;
    const offset = this.#setDocument(code);
    const end = offset + code.length;
    const found = this.#withinBudget(budgetMs, () => [
      ...this.#service.getSyntacticDiagnostics(this.#file),
      ...this.#service.getSemanticDiagnostics(this.#file),
    ]);
    if (found === null) return null;
    const result: CellDiagnostic[] = [];
    for (const d of found) {
      if (d.start === undefined || d.start < offset || d.start > end) continue;
      if (d.category !== ts.DiagnosticCategory.Error && d.category !== ts.DiagnosticCategory.Warning) continue;
      const start = d.start - offset;
      const stop = Math.min(d.start + (d.length ?? 0), end) - offset;
      if (this.#ignored(d.code, code.slice(start, stop), code)) continue;
      result.push({
        start,
        end: stop,
        severity: d.category === ts.DiagnosticCategory.Error ? "error" : "warning",
        code: d.code,
        message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      });
    }
    return result;
  }

  /**
   * The signature of the call `cursor` (a UTF-16 index) is inside, in
   * `code`, the cell being edited, checked against the cells that ran as
   * completion is (#522). Null when there is no call, or the check takes
   * longer than `budgetMs`.
   */
  signature(code: string, cursor: number, budgetMs: number): SignatureHelp | null {
    const ts = this.#ts;
    const offset = this.#setDocument(code);
    const help = this.#withinBudget(budgetMs, () =>
      this.#service.getSignatureHelpItems(this.#file, offset + cursor, { triggerReason: { kind: "invoked" } })
    );
    if (help === null || help === undefined || help.items.length === 0) return null;
    const item = help.items[Math.min(Math.max(help.selectedItemIndex, 0), help.items.length - 1)];
    const text = (parts: TS.SymbolDisplayPart[]) => ts.displayPartsToString(parts);
    const parameters = item.parameters.map((p) => ({ label: text(p.displayParts), documentation: text(p.documentation) }));
    return {
      label: text(item.prefixDisplayParts) + parameters.map((p) => p.label).join(text(item.separatorDisplayParts)) + text(item.suffixDisplayParts),
      documentation: text(item.documentation),
      parameters,
      activeParameter: help.argumentIndex,
    };
  }

  /**
   * Where the name at `cursor` in `cells[cell]` is declared, among
   * `cells`: the notebook as the frontend shows it, not the cells that ran
   * (#522). A name declared in more than one cell has the declaration
   * nearest before the cursor (see #setNotebook). Locations outside the
   * cells (a package's types, the kernel's globals) are left out. Null when
   * the check takes longer than `budgetMs`.
   */
  definition(cells: string[], cell: number, cursor: number, budgetMs: number): CellSpan[] | null {
    const notebook = this.#setNotebook(cells, cell);
    const position = notebook.starts[cell] + cursor;
    const found = this.#withinBudget(budgetMs, () => this.#service.getDefinitionAtPosition(this.#file, position) ?? []);
    if (found === null) return null;
    const spans = found.filter((d) => this.#isNotebook(d.fileName)).flatMap((d) => notebook.span(d.textSpan) ?? []);
    const governed = notebook.governed(spans, cell);
    return "problem" in governed ? [] : governed.spans;
  }

  /**
   * The edits that rename the name at `cursor` in `cells[cell]` to
   * `newName`, across `cells` (#522), or the reason it can't be renamed: a
   * keyword, something declared in a package's types or the kernel's
   * globals, a name that isn't declared in the notebook.
   *
   * A name that more than one cell declares is renamed for the declaration
   * the cursor's name refers to, the nearest one at or before it, and for
   * what that declaration governs: its uses, up to the next cell that
   * declares the name again. That declaration and the ones after it are
   * separate variables, so the later ones, and the names used after them,
   * keep their name (docs/notebooks.md). Null when the check takes longer
   * than `budgetMs`.
   */
  rename(cells: string[], cell: number, cursor: number, newName: string, budgetMs: number): RenameResult | null {
    if (!IDENTIFIER.test(newName) || RESERVED.has(newName)) {
      return { error: `${JSON.stringify(newName)} is not a valid name` };
    }
    const notebook = this.#setNotebook(cells, cell);
    const position = notebook.starts[cell] + cursor;
    const found = this.#withinBudget(budgetMs, (): { error: string } | { locations: readonly TS.RenameLocation[] } => {
      const info = this.#service.getRenameInfo(this.#file, position, { allowRenameOfImportPath: false });
      if (!info.canRename) {
        // A name one cell declares as a value and another as a type, say,
        // doesn't resolve in both: only one is in the file (see #setNotebook).
        const word = wordAt(cells[cell], cursor);
        const declaredIn = this.#statementsOf(cells).filter((c) => c.some((st) => st.names.includes(word))).length;
        return { error: declaredIn > 1 ? `${JSON.stringify(word)} is declared in more than one cell in a way rename can't follow` : info.localizedErrorMessage };
      }
      const locations = this.#service.findRenameLocations(this.#file, position, false, false, { providePrefixAndSuffixTextForRename: true });
      return locations === undefined ? { error: "This name can't be renamed" } : { locations };
    });
    if (found === null) return null;
    if ("error" in found) return found;
    // Renaming something another file declares would leave it as it was.
    if (found.locations.some((l) => !this.#isNotebook(l.fileName))) return { error: "This name is declared outside the notebook" };
    const located = found.locations.flatMap((l) => {
      const span = notebook.span(l.textSpan);
      return span === null ? [] : [{ ...span, text: `${l.prefixText ?? ""}${newName}${l.suffixText ?? ""}` }];
    });
    const governed = notebook.governed(located, cell);
    if ("problem" in governed) {
      return {
        error: governed.problem === "later"
          ? "This name is declared only in a later cell"
          : `${JSON.stringify(governed.name)} is declared in more than one cell in a way rename can't follow`,
      };
    }
    // A property or local the renamed symbol was found through a variable
    // that a cell in between declares again: the edits would miss that
    // cell's own declaration.
    const again = notebook.redeclaredBetween(governed.spans, governed.topLevel);
    if (again !== null) return { error: `${JSON.stringify(again)} is declared again in a later cell; rename it there separately` };
    return { edits: governed.spans };
  }

  /** Runs `run` with a deadline that cancels TypeScript's work in it: null if it took longer than `budgetMs`. */
  #withinBudget<T>(budgetMs: number, run: () => T): T | null {
    this.#deadline = Date.now() + budgetMs;
    try {
      return run();
    } catch (err) {
      if (err instanceof this.#ts.OperationCanceledException) return null;
      throw err;
    } finally {
      this.#deadline = Infinity;
    }
  }

  #isNotebook(fileName: string): boolean {
    return fileName.replaceAll("\\", "/") === this.#file.replaceAll("\\", "/");
  }

  /**
   * Whether diagnostic `code` on `text` (the span it marks) in `cell` is one
   * notebook rules cause.
   */
  #ignored(code: number, text: string, cell: string): boolean {
    // A cell may declare again what an earlier cell declared: it replaces
    // it. Declaring it twice in the one cell is still an error.
    if (REDECLARATION.has(code)) {
      const inCell = this.#statements(cell).flatMap((s) => s.names).filter((n) => n === text).length;
      return inCell <= 1 && this.#cells.some((c) => c.statements.some((s) => s.names.includes(text)));
    }
    // A package an import hasn't installed yet, or one without types.
    // A relative path that isn't there is a real error.
    if (MODULE_NOT_FOUND.has(code)) return !/^["'`](?:\.{0,2}\/)/.test(text);
    return code === UNTYPED_MODULE;
  }

  /** Sets the virtual file to the history plus `code`; returns where `code` starts. */
  #setDocument(code: string): number {
    this.#noteImports(code);
    const history = this.#history(new Set(this.#statements(code).flatMap((s) => s.names)));
    const text = `${PREFIX}${history}\n`;
    this.#text = text + code;
    this.#version++;
    return text.length;
  }

  /** The executed cells, minus declarations a later cell (or `seen`) makes again. */
  #history(seen: Set<string>): string {
    return this.#withoutRedeclared(this.#cells, seen).join("\n");
  }

  /**
   * Each of `cells` with the statements a later cell (or `seen`) declares
   * again blanked out, which leaves every other character where it was.
   */
  #withoutRedeclared(cells: Cell[], seen: Set<string>): string[] {
    const kept: string[] = [];
    for (let i = cells.length - 1; i >= 0; i--) {
      const { code, statements } = cells[i];
      let text = code;
      for (const { start, end, names } of statements) {
        if (names.length > 0 && names.every((n) => seen.has(n))) text = text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, " ") + text.slice(end);
      }
      for (const s of statements) for (const n of s.names) seen.add(n);
      kept.push(text);
    }
    return kept.reverse();
  }

  /**
   * Sets the virtual file to the frontend's `cells`, for definition and
   * rename (#522): a cell is in the file where it is in the notebook, and
   * the declarations the cells before `cell` (the one being edited) make
   * again are blanked, so a name resolves to its nearest declaration before
   * `cell`, as at runtime. Cells after it are kept whole: they hold uses.
   */
  #setNotebook(texts: string[], cell: number) {
    for (const t of texts) this.#noteImports(t);
    const cells: Cell[] = texts.map((code) => ({ code, statements: this.#statements(code) }));
    const seen = new Set(cells[cell].statements.flatMap((s) => s.names));
    const pieces = [...this.#withoutRedeclared(cells.slice(0, cell), seen), ...texts.slice(cell)];
    const starts: number[] = [];
    let text = PREFIX;
    for (const piece of pieces) {
      starts.push(text.length);
      text += `${piece}\n`;
    }
    this.#text = text;
    this.#version++;
    return {
      starts,
      /** A span of the file as one of the cell's, or null if it isn't inside a cell. */
      span: ({ start, length }: TS.TextSpan): CellSpan | null => cellSpan(starts, texts, start, length),
      /**
       * `spans` as far as the declaration they are about governs them. When
       * they include a top-level declaration, the name is a notebook
       * variable, and a cell that declares it again starts another: keep
       * the spans from the nearest declaration at or before `at` up to
       * that cell. "later" when every declaration is in a later cell, and
       * "partial" when a cell declares again only some of the names of an
       * earlier statement, which is then still in the file, so the name
       * doesn't resolve to the nearest declaration. Spans with no
       * top-level declaration (a property, a local) are all kept.
       */
      governed: <T extends CellSpan>(
        spans: T[],
        at: number,
      ): { spans: T[]; topLevel: boolean } | { problem: "later" | "partial"; name: string } => {
        const declared = spans.filter((s) => cells[s.cell].statements.some((st) => st.spans.some((d) => d.start === s.start && d.end === s.end)));
        if (declared.length === 0) return { spans, topLevel: false };
        const name = cells[declared[0].cell].code.slice(declared[0].start, declared[0].end);
        if (partiallyRedeclared(cells, name, at)) return { problem: "partial", name };
        const from = Math.max(-1, ...declared.map((d) => d.cell).filter((c) => c <= at));
        if (from < 0) return { problem: "later", name };
        const to = cells.findIndex((c, i) => i > from && c.statements.some((st) => st.names.includes(name)));
        return { spans: spans.filter((s) => s.cell >= from && (to < 0 || s.cell < to)), topLevel: true };
      },
      /**
       * For a rename of something that isn't a top-level name: a top-level
       * name that the cells with edits use and that a cell after the first
       * of them (up to the last) declares again, or null. The symbol was
       * found through the declaration the cursor sees, so the edits would
       * miss what that cell declares.
       */
      redeclaredBetween: (spans: CellSpan[], topLevel: boolean): string | null => {
        if (topLevel || spans.length === 0) return null;
        const editCells = spans.map((s) => s.cell);
        const first = Math.min(...editCells);
        const last = Math.max(...editCells);
        const names = new Set(cells.slice(first + 1, last + 1).flatMap((c) => c.statements.flatMap((st) => st.names)));
        for (const name of names) {
          const declaring = cells.filter((c) => c.statements.some((st) => st.names.includes(name))).length;
          if (declaring < 2) continue;
          const word = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`);
          if (editCells.some((i) => word.test(texts[i]))) return name;
        }
        return null;
      },
    };
  }

  /** The top-level statements of each of `texts`. */
  #statementsOf(texts: string[]): Statement[][] {
    return texts.map((code) => this.#statements(code));
  }

  #statements(code: string): Statement[] {
    const ts = this.#ts;
    const sf = ts.createSourceFile("cell.ts", code, ts.ScriptTarget.ESNext, false, ts.ScriptKind.TS);
    return sf.statements.map((stmt) => {
      const ids = this.#declaredNames(stmt);
      return {
        start: stmt.pos,
        end: stmt.end,
        names: ids.map((id) => id.text),
        spans: ids.map((id) => ({ start: id.getStart(sf), end: id.end })),
      };
    });
  }

  #declaredNames(stmt: TS.Statement): TS.Identifier[] {
    const ts = this.#ts;
    const bound = (name: TS.BindingName): TS.Identifier[] =>
      ts.isIdentifier(name)
        ? [name]
        : name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bound(e.name)));
    if (ts.isVariableStatement(stmt)) return stmt.declarationList.declarations.flatMap((d) => bound(d.name));
    if (
      (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) ||
        ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) && stmt.name
    ) {
      return [stmt.name];
    }
    if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const clause = stmt.importClause;
      const names = clause.name ? [clause.name] : [];
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) names.push(...bindings.elements.map((e) => e.name));
      if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name);
      return names;
    }
    return [];
  }

  /** Notifies `onImportSpecifiers` for any newly observed module specifiers in `code`. */
  #noteImports(code: string): void {
    const notify = this.#hostOptions.onImportSpecifiers;
    if (notify === undefined) return;
    const info = this.#ts.preProcessFile(code, true, true);
    const fresh: string[] = [];
    for (const file of info.importedFiles) {
      if (!this.#reportedSpecifiers.has(file.fileName)) {
        this.#reportedSpecifiers.add(file.fileName);
        fresh.push(file.fileName);
      }
    }
    if (fresh.length > 0) notify(fresh);
  }

  /** Where an npm:/jsr: import is installed in the kernel's npm cache, if it is. */
  #cachedPackage(specifier: string): { dir: string; alias: string; subpath: string } | null {
    return this.#hostOptions.cachedPackage?.(specifier) ?? null;
  }

  #resolve(name: string, containingFile: string): TS.ResolvedModuleWithFailedLookupLocations {
    const ts = this.#ts;
    const remote = this.#remoteModules.get(name);
    if (remote !== undefined) {
      const extension = extensionOf(ts, remote);
      if (extension !== undefined) {
        return { resolvedModule: { resolvedFileName: remote, extension, isExternalLibraryImport: true } };
      }
    }
    const typesRoot = /^(\/types\/https?\/[^/]+)\//.exec(containingFile)?.[1];
    if (typesRoot !== undefined && name.startsWith("/") && !name.startsWith("/types/")) {
      return ts.resolveModuleName(typesRoot + name, containingFile, this.#compilerOptions, this.#resolutionHost, this.#resolutionCache);
    }
    const deno = this.#options.deno;
    // Only what an executed cell imported (or a fetched module imports):
    // looking a specifier up never makes Deno fetch something new.
    if (deno !== undefined && !/^(?:\.{0,2}\/|node:)/.test(name) && (this.#imported.has(name) || containingFile.startsWith(deno.root))) {
      const found = deno.lookup(name);
      if (found?.kind === "npm") {
        return ts.resolveModuleName(this.#join(found.dir, found.subpath), containingFile, this.#compilerOptions, this.#resolutionHost, this.#resolutionCache);
      }
      const extension = found?.kind === "remote" ? extensionOf(ts, found.path) : undefined;
      if (found?.kind === "remote" && extension !== undefined) {
        return { resolvedModule: { resolvedFileName: found.path, extension, isExternalLibraryImport: false } };
      }
    }
    if (this.#options.npmCache !== null && /^(?:npm|jsr):/.test(name)) {
      const cached = this.#cachedPackage(name);
      // Resolved as its alias from the cache directory, so package.json
      // "exports" and "types" apply as for any package.
      if (cached !== null) {
        const from = this.#join(cached.dir, "__cdpk__.ts");
        return ts.resolveModuleName(cached.alias + cached.subpath, from, this.#compilerOptions, this.#resolutionHost, this.#resolutionCache);
      }
    }
    return ts.resolveModuleName(name, containingFile, this.#compilerOptions, this.#resolutionHost, this.#resolutionCache);
  }

  #host(): TS.LanguageServiceHost {
    const ts = this.#ts;
    const file = this.#file;
    const globalsFile = this.#globalsFile;
    const deno = this.#options.deno;
    const fs = this.#hostOptions.fs;
    const libDir = this.#hostOptions.libDir;
    const virtual = (f: string) => {
      if (f === file) return this.#text;
      if (f === globalsFile) return this.#options.globals;
      const local = deno?.localFile(f);
      return local !== undefined ? fs.readFile(local) : this.#virtualTypes.get(f);
    };
    return {
      getCompilationSettings: () => this.#compilerOptions,
      getProjectVersion: () => `${this.#projectVersion}.${this.#version}`,
      getScriptFileNames: () => [file, globalsFile, ...this.#virtualTypes.keys(), ...this.#typeFiles],
      getScriptVersion: (f) => (f === file ? String(this.#version) : "0"),
      getScriptSnapshot: (f) => {
        const text = virtual(f) ?? fs.readFile(f);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => this.#options.notebookDir,
      getDefaultLibFileName: (o) => libDir === undefined ? ts.getDefaultLibFilePath(o) : this.#join(libDir, ts.getDefaultLibFileName(o)),
      fileExists: (f) => f === file || f === globalsFile || this.#virtualTypes.has(f) || deno?.localFile(f) !== undefined || fs.fileExists(f),
      readFile: (f) => virtual(f) ?? fs.readFile(f),
      readDirectory: (path, extensions, exclude, include, depth) => fs.readDirectory?.(path, extensions, exclude, include, depth) ?? [],
      directoryExists: (d) => fs.directoryExists(d),
      getDirectories: (d) => fs.getDirectories(d),
      getCancellationToken: () => ({ isCancellationRequested: () => Date.now() > this.#deadline }),
      resolveModuleNameLiterals: (literals, containingFile) =>
        literals.map((literal) => this.#resolve(literal.text, containingFile)),
    };
  }
}

/** The extension TypeScript should load a remote module's path as, if it's one it can. */
function extensionOf(ts: typeof TS, path: string): TS.Extension | undefined {
  for (const ext of [
    ts.Extension.Dts,
    ts.Extension.Dmts,
    ts.Extension.Dcts,
    ts.Extension.Ts,
    ts.Extension.Mts,
    ts.Extension.Cts,
    ts.Extension.Tsx,
    ts.Extension.Js,
    ts.Extension.Mjs,
    ts.Extension.Cjs,
    ts.Extension.Jsx,
  ]) {
    if (path.endsWith(ext)) return ext;
  }
  return undefined;
}

/**
 * Declarations for the names the kernel adds to every target, as in
 * src/globals.ts. `display` is runtime/display.mjs's path; its sibling
 * display.d.mts types `jupyter`. Without it (a kernel run from JSR, whose
 * runtime files aren't local), `jupyter` is untyped. `untyped` names
 * globals the target has without types, declared `any` so they aren't
 * errors (#514).
 */
export function kernelGlobals(display: string | null, untyped: string[] = []): string {
  const jupyter = display === null ? "any" : `import(${JSON.stringify(display)}).JupyterNamespace`;
  return `declare global {${untyped.map((name) => `\n  var ${name}: any;`).join("")}
  /** The notebook display API: display, md/html/svg templates, image, format, broadcast. */
  var jupyter: ${jupyter};
  /** Asks the frontend for a line of input. Null when the frontend didn't allow input for this cell. */
  function prompt(message?: string, defaultValue?: string, options?: { password?: boolean }): string | null;
  /** Asks a yes/no question over the Jupyter stdin channel. */
  function confirm(message?: string): boolean;
}
export {};
`;
}
