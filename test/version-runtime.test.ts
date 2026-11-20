// jupyter.version and jupyter.runtime on each target a test can launch
// (#531). The browser target is covered by test/browser.test.ts, celld's
// config by test/celld-target.test.ts, and test/e2e.py runs every variant.
import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BunTarget } from "../src/bun-target.ts";
import { VERSION } from "../src/package.ts";
import { Target, type TargetEvents, type TargetMessage } from "../src/target.ts";
import { loadTypeStripper } from "../src/transform.ts";
import { WorkerdTarget } from "../src/workerd-target.ts";
import { hasBun } from "./bun.ts";

await loadTypeStripper("esbuild");

const WORKERD = join(fileURLToPath(new URL("../node_modules/.bin/", import.meta.url)), "workerd");

// Bun and workerd hand back handles, not values, so the cell publishes what
// it saw as a named result and the test reads that message.
const PROBE = `await jupyter.result("probe", {
  version: jupyter.version,
  runtime: jupyter.runtime,
  frozen: Object.isFrozen(jupyter.runtime),
  sameObject: jupyter.runtime === jupyter.runtime,
  readOnly: (() => {
    "use strict";
    try {
      jupyter.version = "x";
      return false;
    } catch {
      return true;
    }
  })(),
})`;

interface Probe {
  version: string;
  runtime: { name: string; version: string };
  frozen: boolean;
  sameObject: boolean;
  readOnly: boolean;
}

interface Launched {
  target: {
    evaluate(code: string): Promise<{ exceptionDetails?: unknown }>;
    transform(code: string, o: object): string;
    flush(): Promise<void> | void;
    kill(): void;
  };
  messages: TargetMessage[];
}

async function launched(t: TestContext, start: (events: TargetEvents) => Promise<Launched["target"]>): Promise<Launched> {
  const messages: TargetMessage[] = [];
  const target = await start({ stream: () => {}, message: (m) => void messages.push(m), exit: () => {} });
  t.after(() => target.kill());
  return { target, messages };
}

async function probe({ target, messages }: Launched): Promise<Probe> {
  const res = await target.evaluate(target.transform(PROBE, {}));
  assert.equal(res.exceptionDetails, undefined, JSON.stringify(res.exceptionDetails));
  await target.flush();
  const data = messages.flatMap((m) => (m.kind === "iopub" && m.msg_type === "display_data" ? [(m.content as { data: Record<string, unknown> }).data] : []));
  const found = data.map((d) => d["application/vnd.ganymede.result+json"] as { name: string; value: Probe }).find((r) => r?.name === "probe");
  assert.ok(found, "the cell's result message arrived");
  return found.value;
}

test("Node: jupyter.version is VERSION and jupyter.runtime names node with its version", async (t) => {
  const got = await probe(await launched(t, (events) => Target.launch("node", events)));
  assert.equal(got.version, VERSION);
  assert.deepEqual(got.runtime, { name: "node", version: process.versions.node });
  assert.deepEqual([got.frozen, got.sameObject, got.readOnly], [true, true, true]);
});

test("Bun: jupyter.version is VERSION and jupyter.runtime names bun with its version", { skip: !hasBun() }, async (t) => {
  const got = await probe(await launched(t, (events) => BunTarget.launch(events)));
  assert.equal(got.version, VERSION);
  assert.equal(got.runtime.name, "bun");
  assert.match(got.runtime.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual([got.frozen, got.sameObject, got.readOnly], [true, true, true]);
});

test("workerd: jupyter.version is VERSION and jupyter.runtime names workerd without a version", {
  skip: !existsSync(WORKERD) || process.platform === "win32",
}, async (t) => {
  const got = await probe(await launched(t, (events) => WorkerdTarget.launch(events, { executable: WORKERD })));
  assert.equal(got.version, VERSION);
  assert.deepEqual(got.runtime, { name: "workerd", version: "" });
  assert.deepEqual([got.frozen, got.sameObject, got.readOnly], [true, true, true]);
});
