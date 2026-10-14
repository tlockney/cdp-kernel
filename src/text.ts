// Text helpers for is_complete and complete requests.
//
// Ported from Deno's cli/js/jupyter_kernel.js (v2.9.6), which is
// Copyright 2018-2026 the Deno authors, MIT license.

export type IsCompleteReply =
  | { status: "complete" }
  | { status: "incomplete"; indent: string }
  | { status: "invalid" };

/** Bracket/quote/comment scanner deciding whether a cell is finished. */
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
    if (ch === "'" || ch === '"' || ch === "`") {
      i++;
      let closed = false;
      while (i < code.length) {
        if (code[i] === "\\" && ch !== "`") {
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
