// Result formatting on Node vs Deno targets (#17): the catalogue of where
// util.inspect and Deno.inspect differ, kept honest by running both on the
// same values (test/fixtures/formatting). The decision recorded in
// docs/known-gaps.md is to keep each runtime's own format; this test fails
// if a new kind of difference appears, so the decision can be revisited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DUMP = fileURLToPath(new URL("./fixtures/formatting/dump.mjs", import.meta.url));
const hasDeno = spawnSync("deno", ["--version"], { stdio: "ignore" }).status === 0;

type Row = { name: string; text: string };

function dump(cmd: string, args: string[]): Map<string, string> {
  const out = execFileSync(cmd, [...args, DUMP], { encoding: "utf8" });
  return new Map(out.trim().split("\n").map((line) => {
    const row = JSON.parse(line) as Row;
    return [row.name, row.text];
  }));
}

/** Strings quoted '…' on Node, "…" on Deno; everything else equal. */
const QUOTE_ONLY = ["string", "plain object", "Map", "Set", "long string in object", "multiline string"];
/** Node's stack also lists its own module-loader frames; the message matches. */
const STACK_ONLY = ["Error"];
/** Node before 24 brackets symbol keys, `{ [Symbol(k)]: 1 }`; Node 24+ and Deno don't. */
const SYMBOL_KEY = Number(process.versions.node.split(".")[0]) < 24 ? ["object with symbol key"] : [];

function swapQuotes(text: string): string {
  return text.replace(/'((?:[^'\\]|\\.)*)'/g, (_, body: string) => `"${body}"`);
}

test("Node and Deno format results alike, except for string quotes and Node's internal stack frames", { skip: !hasDeno }, () => {
  const node = dump(process.execPath, []);
  const deno = dump("deno", ["run", "--no-config", "--no-lock"]);
  assert.deepEqual([...node.keys()], [...deno.keys()]);
  const differing = [...node.keys()].filter((name) => node.get(name) !== deno.get(name));
  assert.deepEqual(differing.sort(), [...QUOTE_ONLY, ...STACK_ONLY, ...SYMBOL_KEY].sort(), "the catalogued differences, no more and no fewer");
  for (const name of QUOTE_ONLY) {
    assert.equal(swapQuotes(node.get(name) ?? ""), deno.get(name), `${name}: only the quotes differ`);
  }
  for (const name of STACK_ONLY) {
    assert.equal(node.get(name)?.split("\n")[0], deno.get(name)?.split("\n")[0], `${name}: the same message`);
  }
  for (const name of SYMBOL_KEY) {
    assert.equal(node.get(name)?.replace(/\[(Symbol\(.*?\))\]/g, "$1"), deno.get(name), `${name}: only the brackets differ`);
  }
});
