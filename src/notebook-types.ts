// TypeScript's language service over a notebook (#263): completion from
// declared types, where the runtime only knows values. Runs in a worker
// (src/language-service-worker.ts); see probes/ts-language-service.md for
// the design and its measurements.
//
// The service sees one virtual file, never written to disk, in the
// notebook's directory (so relative imports resolve from there): the cells
// executed so far, then the cell being edited. REPL cells redeclare names
// all the time (`const x = 1`, later `const x = "s"`), which in one file is
// an error that keeps the first type, so a declaration is dropped from the
// history when a later cell, or the one being edited, declares all of its
// names again.

import type TS from "typescript";
import { join } from "node:path";
import { findLockFile, installedPackageDir, jsrToNpm, parsePackageSpecifier } from "../runtime/node-hooks.mjs";

export interface NotebookTypesOptions {
  notebookDir: string;
  /**
   * Resolve npm: and jsr: imports from the kernel's npm cache, where
   * Node-hosted targets install them. Deno targets resolve them natively.
   */
  npmCache: boolean;
  /** compilerOptions.types: type packages found from the notebook's directory. */
  types: string[];
  /** Declaration files every cell sees, e.g. runtime types. */
  typeFiles: string[];
  /** Declarations for the kernel's own globals (jupyter, prompt, confirm). */
  globals: string;
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

/** One top-level statement of an executed cell, and the names it declares. */
interface Statement {
  start: number;
  end: number;
  names: string[];
}

interface Cell {
  code: string;
  statements: Statement[];
}

// The document is a module, so top-level await in a cell isn't an error.
const PREFIX = "export {};\n";

export class NotebookTypes {
  readonly #ts: typeof TS;
  readonly #options: NotebookTypesOptions;
  readonly #file: string;
  readonly #globalsFile: string;
  readonly #service: TS.LanguageService;
  #compilerOptions: TS.CompilerOptions;
  readonly #resolutionCache: TS.ModuleResolutionCache;
  readonly #cells: Cell[] = [];
  #typeFiles: string[];
  #text = PREFIX;
  #version = 0;
  #projectVersion = 0;

  constructor(ts: typeof TS, options: NotebookTypesOptions) {
    this.#ts = ts;
    this.#options = options;
    this.#typeFiles = [...options.typeFiles];
    this.#file = join(options.notebookDir, "__cdpk_notebook__.ts");
    this.#globalsFile = join(options.notebookDir, "__cdpk_globals__.d.ts");
    this.#compilerOptions = {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      allowJs: true,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      lib: ["lib.esnext.d.ts"],
      types: options.types,
    };
    const host = this.#host();
    this.#resolutionCache = ts.createModuleResolutionCache(options.notebookDir, (f) => f, this.#compilerOptions);
    this.#service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  /** An executed cell: its declarations are in scope for later ones. */
  addCell(code: string): void {
    this.#cells.push({ code, statements: this.#statements(code) });
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
    const host = { ...this.#ts.sys, getCurrentDirectory: () => this.#options.notebookDir };
    const resolved = this.#ts.resolveTypeReferenceDirective(name, this.#file, this.#compilerOptions, host);
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
    const lines = [ts.displayPartsToString(info.displayParts)];
    // What an undeclared name gets, e.g. a global a library set at runtime.
    if (lines[0] === "any") return null;
    const docs = ts.displayPartsToString(info.documentation);
    if (docs !== "") lines.push(docs);
    for (const tag of info.tags ?? []) {
      const text = ts.displayPartsToString(tag.text);
      lines.push(`@${tag.name}${text === "" ? "" : ` ${text}`}`);
    }
    return lines.join("\n");
  }

  /** Sets the virtual file to the history plus `code`; returns where `code` starts. */
  #setDocument(code: string): number {
    const history = this.#history(new Set(this.#statements(code).flatMap((s) => s.names)));
    const text = `${PREFIX}${history}\n`;
    this.#text = text + code;
    this.#version++;
    return text.length;
  }

  /** The executed cells, minus declarations a later cell (or `seen`) makes again. */
  #history(seen: Set<string>): string {
    const kept: string[] = [];
    for (let i = this.#cells.length - 1; i >= 0; i--) {
      const { code, statements } = this.#cells[i];
      let text = code;
      // Back to front, so earlier offsets stay valid.
      for (let j = statements.length - 1; j >= 0; j--) {
        const { start, end, names } = statements[j];
        if (names.length > 0 && names.every((n) => seen.has(n))) text = text.slice(0, start) + text.slice(end);
      }
      for (const s of statements) for (const n of s.names) seen.add(n);
      kept.push(text);
    }
    return kept.reverse().join("\n");
  }

  #statements(code: string): Statement[] {
    const ts = this.#ts;
    const sf = ts.createSourceFile("cell.ts", code, ts.ScriptTarget.ESNext, false, ts.ScriptKind.TS);
    return sf.statements.map((stmt) => ({ start: stmt.pos, end: stmt.end, names: this.#declaredNames(stmt) }));
  }

  #declaredNames(stmt: TS.Statement): string[] {
    const ts = this.#ts;
    const bound = (name: TS.BindingName): string[] =>
      ts.isIdentifier(name)
        ? [name.text]
        : name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bound(e.name)));
    if (ts.isVariableStatement(stmt)) return stmt.declarationList.declarations.flatMap((d) => bound(d.name));
    if (
      (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) ||
        ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) && stmt.name
    ) {
      return [stmt.name.text];
    }
    if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const clause = stmt.importClause;
      const names = clause.name ? [clause.name.text] : [];
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) names.push(...bindings.elements.map((e) => e.name.text));
      if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
      return names;
    }
    return [];
  }

  /** Where an npm:/jsr: import is installed in the kernel's npm cache, if it is. */
  #cachedPackage(specifier: string): { dir: string; alias: string; subpath: string } | null {
    try {
      const pkg = specifier.startsWith("npm:")
        ? parsePackageSpecifier(specifier.slice(4))
        : jsrToNpm(specifier.slice(4));
      const installed = installedPackageDir(pkg, "npm", { lockFile: findLockFile(this.#options.notebookDir) });
      return installed === null ? null : { ...installed, subpath: pkg.subpath };
    } catch {
      return null;
    }
  }

  #resolve(name: string, containingFile: string): TS.ResolvedModuleWithFailedLookupLocations {
    const ts = this.#ts;
    if (this.#options.npmCache && /^(?:npm|jsr):/.test(name)) {
      const cached = this.#cachedPackage(name);
      // Resolved as its alias from the cache directory, so package.json
      // "exports" and "types" apply as for any package.
      if (cached !== null) {
        const from = join(cached.dir, "__cdpk__.ts");
        return ts.resolveModuleName(cached.alias + cached.subpath, from, this.#compilerOptions, ts.sys, this.#resolutionCache);
      }
    }
    return ts.resolveModuleName(name, containingFile, this.#compilerOptions, ts.sys, this.#resolutionCache);
  }

  #host(): TS.LanguageServiceHost {
    const ts = this.#ts;
    const file = this.#file;
    const globalsFile = this.#globalsFile;
    const virtual = (f: string) => (f === file ? this.#text : f === globalsFile ? this.#options.globals : undefined);
    return {
      getCompilationSettings: () => this.#compilerOptions,
      getProjectVersion: () => `${this.#projectVersion}.${this.#version}`,
      getScriptFileNames: () => [file, globalsFile, ...this.#typeFiles],
      getScriptVersion: (f) => (f === file ? String(this.#version) : "0"),
      getScriptSnapshot: (f) => {
        const text = virtual(f) ?? ts.sys.readFile(f);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => this.#options.notebookDir,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: (f) => virtual(f) !== undefined || ts.sys.fileExists(f),
      readFile: (f) => virtual(f) ?? ts.sys.readFile(f),
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      resolveModuleNameLiterals: (literals, containingFile) =>
        literals.map((literal) => this.#resolve(literal.text, containingFile)),
    };
  }
}

/**
 * Declarations for the names the kernel adds to every target, as in
 * src/globals.ts. `display` is runtime/display.mjs's path; its sibling
 * display.d.mts types `jupyter`. Without it (a kernel run from JSR, whose
 * runtime files aren't local), `jupyter` is untyped.
 */
export function kernelGlobals(display: string | null): string {
  const jupyter = display === null ? "any" : `import(${JSON.stringify(display)}).JupyterNamespace`;
  return `declare global {
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
