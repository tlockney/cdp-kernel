// Text helpers for is_complete and complete requests.
//
// Ported from Deno's cli/js/jupyter_kernel.js (v2.9.6), which is
// Copyright 2018-2026 the Deno authors, MIT license.

export type IsCompleteReply =
  | { status: "complete" }
  | { status: "incomplete"; indent: string }
  | { status: "invalid" };

// Keywords after which a `/` starts a regex literal rather than dividing.
const REGEX_AFTER_WORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw",
  "case", "do", "else", "yield", "await",
]);

/**
 * Whether a `/` at `i` (not starting a comment) begins a regex literal: the
 * usual heuristic, true unless the previous token can end an operand (a
 * name, number, closing bracket or string). It can't tell `a++ / b` or a
 * block's `} /re/` apart; those are rare enough in a console.
 */
function startsRegex(code: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(code[j])) j--;
  if (j < 0) return true;
  const prev = code[j];
  if (/[\w$]/.test(prev)) {
    const word = /[\w$]+$/.exec(code.slice(0, j + 1))?.[0] ?? "";
    return REGEX_AFTER_WORD.has(word);
  }
  return !/[)\]}'"`]/.test(prev);
}

/** The index just past a regex literal starting at `i`, or -1 if it doesn't end on its line. */
function regexEnd(code: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < code.length; j++) {
    const c = code[j];
    if (c === "\n") return -1;
    if (c === "\\") j++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return j + 1;
  }
  return -1;
}

/**
 * Bracket/quote/comment scanner deciding whether a cell is finished. Regex
 * literals are recognised heuristically (see startsRegex), and a template's
 * `${...}` is skipped like the rest of the template.
 */
export function checkIsComplete(code: string): IsCompleteReply {
  const stack: string[] = [];
  const closers: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "/" && code[i + 1] === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      if (end === -1) return { status: "incomplete", indent: "" };
      i = end + 2;
      continue;
    }
    if (ch === "/" && startsRegex(code, i)) {
      const end = regexEnd(code, i);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      i++;
      let closed = false;
      while (i < code.length) {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i++] === ch) {
          closed = true;
          break;
        }
      }
      if (!closed) return { status: "incomplete", indent: "" };
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
    else if (ch in closers && stack.pop() !== closers[ch]) return { status: "invalid" };
    i++;
  }
  return stack.length === 0 ? { status: "complete" } : { status: "incomplete", indent: "  " };
}

/** The dotted expression ending at the cursor, e.g. "Math.fl". */
export function exprAtCursor(code: string, cursor: number): string {
  const m = /[\w$.]+$/.exec(code.slice(0, cursor));
  return m ? m[0] : "";
}

/**
 * The dotted name an inspect_request means (#10): the one the cursor is in
 * or just after, or, right after "name(" while typing a call, that callee.
 * Null when it isn't a plain path; nothing else is evaluated.
 */
export function inspectTarget(code: string, cursor: number): string | null {
  let end = cursor;
  // Inside a call's parentheses with nothing typed yet: "add(|".
  const before = code.slice(0, cursor);
  const call = /([\w$.]+)\(\s*$/.exec(before);
  if (call) end = cursor - (before.length - before.lastIndexOf("(", cursor));
  const head = /[\w$.]*$/.exec(code.slice(0, end))?.[0] ?? "";
  const tail = call ? "" : (/^[\w$]*/.exec(code.slice(end))?.[0] ?? "");
  const path = (head + tail).replace(/\.$/, "");
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(path) ? path : null;
}

// Jupyter measures cursor_pos in Unicode codepoints; JS strings index UTF-16
// code units (denoland/deno#22771).
export function codePointToUtf16Index(str: string, cpOffset: number): number {
  let utf16 = 0;
  for (let cp = 0; cp < cpOffset && utf16 < str.length; cp++) {
    utf16 += (str.codePointAt(utf16) ?? 0) > 0xffff ? 2 : 1;
  }
  return utf16;
}

export function utf16ToCodePointIndex(str: string, utf16Offset: number): number {
  let cp = 0;
  for (let utf16 = 0; utf16 < utf16Offset && utf16 < str.length; cp++) {
    utf16 += (str.codePointAt(utf16) ?? 0) > 0xffff ? 2 : 1;
  }
  return cp;
}
