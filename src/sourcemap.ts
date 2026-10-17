// Line mapping between a cell as written and the script that runs, for the
// debugger (#18): a breakpoint set on a cell's line must land on the line
// esbuild's output put it on, and a paused frame must report the line the
// user wrote. Only lines: Jupyter's breakpoints are per line.

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DIGIT = new Map([...BASE64].map((c, i) => [c, i]));

/** One segment's VLQ fields: generated column, source, line, column, name. */
export function decodeVlq(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = DIGIT.get(char);
    if (digit === undefined) throw new Error(`bad base64 VLQ digit ${JSON.stringify(char)}`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    values.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = 0;
    shift = 0;
  }
  return values;
}

/**
 * For each generated line (0-based), the first original line (0-based) a
 * segment on it maps to, or -1. Source-map fields are relative to the
 * previous segment's; only the original line is tracked.
 */
export function generatedToOriginalLines(mappings: string): number[] {
  const lines: number[] = [];
  let original = 0;
  for (const line of mappings.split(";")) {
    let first = -1;
    for (const segment of line.split(",")) {
      if (!segment) continue;
      const fields = decodeVlq(segment);
      if (fields.length >= 4) {
        original += fields[2];
        if (first === -1) first = original;
      }
    }
    lines.push(first);
  }
  return lines;
}

/** Both directions between the lines of a cell and of its script (0-based). */
export class LineMap {
  readonly #toOriginal: number[];
  readonly #toGenerated = new Map<number, number>();

  /**
   * `offset`: lines the script adds before esbuild's output (the prelude).
   * `generated`: that output. A stripper that keeps lines blanks a
   * type-only line in place and still maps it; with the output given, a
   * blank line counts as unmapped, so a breakpoint there moves down (#239).
   */
  constructor(mappings: string, offset = 0, generated?: string) {
    const blank = generated?.split("\n").map((line) => line.trim() === "");
    const fromEsbuild = generatedToOriginalLines(mappings).map((original, line) => blank?.[line] ? -1 : original);
    this.#toOriginal = [...Array<number>(offset).fill(-1), ...fromEsbuild];
    this.#toOriginal.forEach((original, generated) => {
      if (original !== -1 && !this.#toGenerated.has(original)) this.#toGenerated.set(original, generated);
    });
  }

  /** The cell line a script line came from: its own mapping, or the nearest one above. */
  toOriginal(generated: number): number {
    for (let line = Math.min(generated, this.#toOriginal.length - 1); line >= 0; line--) {
      if (this.#toOriginal[line] !== -1) return this.#toOriginal[line];
    }
    return 0;
  }

  /**
   * The script line for a cell line, or for the next cell line that has
   * code (a breakpoint on a blank or comment line moves down, as debuggers
   * do), or null past the end.
   */
  toGenerated(original: number): number | null {
    const last = Math.max(-1, ...this.#toGenerated.keys());
    for (let line = original; line <= last; line++) {
      const generated = this.#toGenerated.get(line);
      if (generated !== undefined) return generated;
    }
    return null;
  }
}
