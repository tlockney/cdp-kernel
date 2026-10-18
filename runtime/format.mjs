// A small stand-in for util.inspect and util.format, for targets that have
// neither: the browser Worker (runtime/browser-worker.mjs). Output follows
// Node's for the common cases (strings quoted when nested, objects and
// arrays on one line, Map, Set, Date, Error, class names, circular
// references), without colours.
//
// No imports: this file must load in every target.

const MAX_ITEMS = 100;

// Single quotes, unless the string has some and double quotes or
// backticks would need no escapes, as util.inspect picks.
function quote(s) {
  const q = !s.includes("'") ? "'" : !s.includes('"') ? '"' : !s.includes("`") && !s.includes("${") ? "`" : "'";
  const escaped = s.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll(q, `\\${q}`);
  return `${q}${escaped}${q}`;
}

function key(k) {
  return typeof k === "symbol" ? `[${k.toString()}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k);
}

function className(value) {
  const proto = Object.getPrototypeOf(value);
  if (proto === null) return "[Object: null prototype]";
  const name = proto.constructor?.name;
  return name && name !== "Object" ? name : "";
}

function list(open, items, close, more) {
  if (more > 0) items.push(`... ${more} more item${more === 1 ? "" : "s"}`);
  return items.length === 0 ? `${open}${close}` : `${open} ${items.join(", ")} ${close}`;
}

/** `value` as Node's util.inspect would show it, to `depth` levels. */
export function inspect(value, { depth = 2 } = {}) {
  const seen = [];
  const show = (v, level) => {
    switch (typeof v) {
      case "string":
        return quote(v);
      case "bigint":
        return `${v}n`;
      case "symbol":
        return v.toString();
      case "undefined":
        return "undefined";
      case "function": {
        const isClass = /^class\b/.test(Function.prototype.toString.call(v));
        return isClass ? `[class ${v.name || "(anonymous)"}]` : `[Function${v.name ? `: ${v.name}` : " (anonymous)"}]`;
      }
      case "number":
        return Object.is(v, -0) ? "-0" : String(v);
      case "boolean":
        return String(v);
    }
    if (v === null) return "null";
    if (seen.includes(v)) return "[Circular *1]";
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
    if (v instanceof Promise) return "Promise { <unknown> }";
    if (level > depth) return Array.isArray(v) ? "[Array]" : `[${className(v) || "Object"}]`;
    seen.push(v);
    try {
      if (Array.isArray(v) || ArrayBuffer.isView(v)) {
        const items = Array.from(v).slice(0, MAX_ITEMS).map((x) => show(x, level + 1));
        const prefix = Array.isArray(v) ? "" : `${v.constructor.name}(${v.length}) `;
        return prefix + list("[", items, "]", v.length - items.length);
      }
      if (v instanceof Map) {
        const items = [...v].slice(0, MAX_ITEMS).map(([k, x]) => `${show(k, level + 1)} => ${show(x, level + 1)}`);
        return `Map(${v.size}) ` + list("{", items, "}", v.size - items.length);
      }
      if (v instanceof Set) {
        const items = [...v].slice(0, MAX_ITEMS).map((x) => show(x, level + 1));
        return `Set(${v.size}) ` + list("{", items, "}", v.size - items.length);
      }
      const keys = Reflect.ownKeys(v).filter((k) => Object.getOwnPropertyDescriptor(v, k)?.enumerable);
      const items = keys.slice(0, MAX_ITEMS).map((k) => {
        const d = Object.getOwnPropertyDescriptor(v, k);
        const shown = d.get || d.set ? `[${d.get ? "Getter" : ""}${d.get && d.set ? "/" : ""}${d.set ? "Setter" : ""}]` : show(d.value, level + 1);
        return `${key(k)}: ${shown}`;
      });
      const name = className(v);
      return (name ? `${name} ` : "") + list("{", items, "}", keys.length - items.length);
    } finally {
      seen.pop();
    }
  };
  return show(value, 0);
}

/** console.log's formatting: strings as they are, everything else inspected, %s/%d/%i/%f/%o/%O/%j substituted. */
export function format(...args) {
  let out = [];
  let rest = args;
  if (typeof args[0] === "string" && args.length > 1 && args[0].includes("%")) {
    let i = 1;
    const text = args[0].replace(/%[sdifoOjc%]/g, (spec) => {
      if (spec === "%%") return "%";
      if (i >= args.length) return spec;
      const a = args[i++];
      switch (spec) {
        case "%s":
          return typeof a === "string" ? a : inspect(a, { depth: 1 });
        case "%d":
        case "%i":
          return typeof a === "bigint" ? `${a}n` : String(spec === "%i" ? Math.trunc(Number(a)) : Number(a));
        case "%f":
          return String(Number(a));
        case "%j":
          return JSON.stringify(a);
        case "%c":
          return "";
        default:
          return inspect(a, { depth: 4 });
      }
    });
    out = [text];
    rest = args.slice(i);
  }
  for (const a of rest) out.push(typeof a === "string" ? a : inspect(a));
  return out.join(" ");
}
