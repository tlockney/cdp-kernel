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
  /** ts.sys, plus the remote modules a Deno target fetched (virtual paths). */
  readonly #resolutionHost: TS.ModuleResolutionHost;
  readonly #cells: Cell[] = [];
  /** Specifiers executed cells imported: the target has fetched them. */
  readonly #imported = new Set<string>();
  /** Declaration files that exist only in memory, e.g. `deno types`. */
  readonly #virtualTypes = new Map<string, string>();
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
    const deno = options.deno;
    this.#resolutionHost = {
      ...ts.sys,
      fileExists: (f) => deno?.localFile(f) !== undefined || ts.sys.fileExists(f),
      readFile: (f) => {
        const local = deno?.localFile(f);
        return ts.sys.readFile(local ?? f);
      },
      directoryExists: (d) => (deno !== undefined && d.startsWith(deno.root)) || ts.sys.directoryExists(d),
      getCurrentDirectory: () => options.notebookDir,
    };
    const host = this.#host();
    this.#resolutionCache = ts.createModuleResolutionCache(options.notebookDir, (f) => f, this.#compilerOptions);
    this.#service = ts.createLanguageService(host, ts.createDocumentRegistry());
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
    this.#virtualTypes.set(join(this.#options.notebookDir, name), text);
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
      const installer = this.#options.npmCache ?? "npm";
      const installed = installedPackageDir(pkg, installer, { lockFile: findLockFile(this.#options.notebookDir) });
      return installed === null ? null : { ...installed, subpath: pkg.subpath };
    } catch {
      return null;
    }
  }

  #resolve(name: string, containingFile: string): TS.ResolvedModuleWithFailedLookupLocations {
    const ts = this.#ts;
    const deno = this.#options.deno;
    // Only what an executed cell imported (or a fetched module imports):
    // looking a specifier up never makes Deno fetch something new.
    if (deno !== undefined && !/^(?:\.{0,2}\/|node:)/.test(name) && (this.#imported.has(name) || containingFile.startsWith(deno.root))) {
      const found = deno.lookup(name);
      if (found?.kind === "npm") {
        return ts.resolveModuleName(join(found.dir, found.subpath), containingFile, this.#compilerOptions, this.#resolutionHost, this.#resolutionCache);
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
        const from = join(cached.dir, "__cdpk__.ts");
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
    const virtual = (f: string) => {
      if (f === file) return this.#text;
      if (f === globalsFile) return this.#options.globals;
      const local = deno?.localFile(f);
      return local !== undefined ? ts.sys.readFile(local) : this.#virtualTypes.get(f);
    };
    return {
      getCompilationSettings: () => this.#compilerOptions,
      getProjectVersion: () => `${this.#projectVersion}.${this.#version}`,
      getScriptFileNames: () => [file, globalsFile, ...this.#virtualTypes.keys(), ...this.#typeFiles],
      getScriptVersion: (f) => (f === file ? String(this.#version) : "0"),
      getScriptSnapshot: (f) => {
        const text = virtual(f) ?? ts.sys.readFile(f);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => this.#options.notebookDir,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: (f) => f === file || f === globalsFile || this.#virtualTypes.has(f) || deno?.localFile(f) !== undefined || ts.sys.fileExists(f),
      readFile: (f) => virtual(f) ?? ts.sys.readFile(f),
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      resolveModuleNameLiterals: (literals, containingFile) =>
        literals.map((literal) => this.#resolve(literal.text, containingFile)),
    };
  }
}

/** The extension TypeScript should load a remote module's path as, if it's one it can. */
function extensionOf(ts: typeof TS, path: string): TS.Extension | undefined {
  for (const ext of [ts.Extension.Dts, ts.Extension.Dmts, ts.Extension.Ts, ts.Extension.Mts, ts.Extension.Tsx, ts.Extension.Js, ts.Extension.Mjs, ts.Extension.Jsx]) {
    if (path.endsWith(ext)) return ext;
  }
  return undefined;
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
