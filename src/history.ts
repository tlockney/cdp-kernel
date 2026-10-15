// history_request (#10): the cells this kernel has run, for the frontend's
// history (e.g. arrow-up recall in a console). In memory, for one kernel
// session, which is session 1; earlier sessions aren't kept.

export interface HistoryEntry {
  line: number;
  input: string;
}

/** [session, line, input], as history_reply carries it without output. */
export type HistoryItem = [number, number, string];

export const SESSION = 1;

/** Shell-style glob ("*" and "?") to a whole-string RegExp. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*").replace(/\?/g, "[\\s\\S]");
  return new RegExp(`^${escaped}$`);
}

/**
 * Answers a history_request's content:
 *   tail:   the last `n` entries;
 *   range:  lines `start` to `stop` (exclusive) of `session` (1, 0 or -0
 *           mean this one), all lines when `stop` is missing;
 *   search: entries matching the glob `pattern`, newest `n` when `n` is
 *           set, optionally `unique` by input.
 */
export function queryHistory(entries: readonly HistoryEntry[], content: { [key: string]: unknown }): HistoryItem[] {
  const items = entries.map((e): HistoryItem => [SESSION, e.line, e.input]);
  const n = typeof content.n === "number" && content.n > 0 ? content.n : undefined;
  switch (content.hist_access_type) {
    case "tail":
      return n === undefined ? items : items.slice(-n);
    case "range": {
      const session = typeof content.session === "number" ? content.session : SESSION;
      if (session !== SESSION && session !== 0) return [];
      const start = typeof content.start === "number" ? content.start : 0;
      const stop = typeof content.stop === "number" ? content.stop : Infinity;
      return items.filter(([, line]) => line >= start && line < stop);
    }
    case "search": {
      const pattern = globToRegExp(typeof content.pattern === "string" ? content.pattern : "*");
      let found = items.filter(([, , input]) => pattern.test(input));
      if (content.unique === true) {
        const seen = new Set<string>();
        // Newest occurrence of each input, in order.
        found = found.reverse().filter(([, , input]) => !seen.has(input) && seen.add(input) !== undefined).reverse();
      }
      return n === undefined ? found : found.slice(-n);
    }
    default:
      return [];
  }
}
