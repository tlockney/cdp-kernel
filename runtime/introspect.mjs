// What inspect_request (#10) shows for a value: the text of a JupyterLab
// tooltip (Shift-Tab) or inspector panel. Shared by every target; the host
// decides how the value is found (src/target.ts: CDP's throwOnSideEffect;
// in-process targets: resolvePath, below).
//
// No imports: this file must load in every target. `inspect` (util.inspect
// or Deno.inspect) is passed in.

const PREVIEW_CHARS = 1500;
const SOURCE_CHARS = 4000;
const MAX_PROPERTIES = 40;

const IDENTIFIER_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/**
 * Looks up a dotted path such as "a.b.c" from globalThis, by property
 * descriptor, so nothing runs: a getter along the way is reported rather
 * than called. In-process targets (Bun, workerd, celld) have no way to
 * evaluate without side effects, so inspection and completion use this.
 */
export function resolvePath(path, root = globalThis) {
  if (!IDENTIFIER_PATH.test(path)) return { found: false };
  let value = root;
  for (const name of path.split(".")) {
    if (value === null || value === undefined) return { found: false };
    let descriptor;
    for (let o = Object(value); o !== null && descriptor === undefined; o = Object.getPrototypeOf(o)) {
      descriptor = Object.getOwnPropertyDescriptor(o, name);
    }
    if (descriptor === undefined) return { found: false };
    if (!("value" in descriptor)) return { found: true, accessor: true, name };
    value = descriptor.value;
  }
  return { found: true, value };
}

function truncate(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}… (${text.length - limit} more characters)` : text;
}

/** "function add(a, b) {...}" -> "add(a, b)"; "class K {...}" -> "class K". */
export function signatureOf(fn) {
  let source;
  try {
    source = Function.prototype.toString.call(fn);
  } catch {
    return `${fn.name || "anonymous"}(…)`;
  }
  if (/^class\b/.test(source)) return `class ${fn.name || "(anonymous)"}`;
  const params = /^[^(]*\(([^)]*)\)/.exec(source)?.[1];
  const native = /\{\s*\[native code\]\s*\}$/.test(source);
  // One line, however the parameters were spread over the source.
  const written = (params ?? "").replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").trim();
  const args = native ? Array.from({ length: fn.length }, (_, i) => `arg${i}`).join(", ") : written;
  const arrow = !/^(?:async\s+)?function\b/.test(source) && /=>/.test(source.split("{")[0] ?? "");
  const name = fn.name || (arrow ? "(arrow function)" : "anonymous");
  const prefix = /^async\b/.test(source) ? "async " : "";
  return `${prefix}${name}(${args})`;
}

function typeOf(value) {
  if (value === null) return "null";
  if (typeof value !== "object" && typeof value !== "function") return typeof value;
  const name = Object.getPrototypeOf(value)?.constructor?.name;
  if (typeof value === "function") return /^class\b/.test(safeSource(value)) ? "class" : "function";
  return name && name !== "Object" ? `object (${name})` : "object";
}

function safeSource(fn) {
  try {
    return Function.prototype.toString.call(fn);
  } catch {
    return "";
  }
}

function propertyNames(value) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return [];
  try {
    return Object.getOwnPropertyNames(value).filter((n) => !(typeof value === "function" && ["length", "name", "prototype"].includes(n)));
  } catch {
    return [];
  }
}

/**
 * The tooltip text for a value. `detail` 1 (Shift-Tab twice, or the
 * inspector panel) adds a function's source.
 */
export function describeValue(value, { inspect, detail = 0 }) {
  const lines = [`Type: ${typeOf(value)}`];
  if (typeof value === "function") lines.push(`Signature: ${signatureOf(value)}`);
  let preview;
  try {
    preview = inspect(value);
  } catch (err) {
    preview = `(inspect failed: ${err instanceof Error ? err.message : String(err)})`;
  }
  lines.push(`Value: ${truncate(preview, PREVIEW_CHARS)}`);
  const names = propertyNames(value);
  if (names.length > 0) {
    const shown = names.slice(0, MAX_PROPERTIES).join(", ");
    lines.push(`Properties: ${shown}${names.length > MAX_PROPERTIES ? `, … (${names.length - MAX_PROPERTIES} more)` : ""}`);
  }
  if (detail > 0 && typeof value === "function") lines.push(`Source:\n${truncate(safeSource(value), SOURCE_CHARS)}`);
  return lines.join("\n");
}

/** inspect_request for in-process targets: resolvePath, then describeValue. */
export function inspectPath(path, { inspect, detail = 0, root = globalThis }) {
  const resolved = resolvePath(path, root);
  if (!resolved.found) return null;
  if (resolved.accessor) {
    return `Type: accessor property\n${resolved.name} has a getter, which isn't called for inspection: it could have side effects.`;
  }
  return describeValue(resolved.value, { inspect, detail });
}
