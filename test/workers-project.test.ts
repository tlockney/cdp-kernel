// A Workers project's bindings on the workerd target (#26): config lookup and
// bundling as units, then WorkerdTarget against a fixture project, using
// the wrangler (and its Miniflare) from devDependencies, as a project's own
// would be.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleProject, compatibilityFlagsFor, findWranglerConfig, PROJECT_MAIN } from "../src/workers-project.ts";
import { RESTART_NOTE, WorkerdTarget } from "../src/workerd-target.ts";
import { Interrupted, type TargetEvents, type TargetMessage } from "../src/target.ts";

const REPO = new URL("../", import.meta.url).pathname;
const skip = !existsSync(join(REPO, "node_modules", "wrangler"));

function scratch(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "cdpk-project-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("findWranglerConfig finds the nearest config, any of the three forms", (t) => {
  const dir = scratch(t);
  const nested = join(dir, "a", "b");
  mkdirSync(nested, { recursive: true });
  assert.equal(findWranglerConfig(nested), null);
  writeFileSync(join(dir, "wrangler.toml"), 'name = "x"\n');
  assert.equal(findWranglerConfig(nested), join(dir, "wrangler.toml"));
  writeFileSync(join(dir, "a", "wrangler.json"), "{}");
  assert.equal(findWranglerConfig(nested), join(dir, "a", "wrangler.json"));
  writeFileSync(join(dir, "a", "wrangler.jsonc"), "{}");
  assert.equal(findWranglerConfig(nested), join(dir, "a", "wrangler.jsonc"), "jsonc first, as wrangler prefers");
});

test("compatibilityFlagsFor adds nodejs_compat unless the project chose a variant", () => {
  assert.deepEqual(compatibilityFlagsFor([]), ["nodejs_compat"]);
  // Even for a recent date: an older Miniflare runs an older workerd.
  assert.deepEqual(compatibilityFlagsFor(["x"]), ["x", "nodejs_compat"]);
  assert.deepEqual(compatibilityFlagsFor(["nodejs_compat_v2"]), ["nodejs_compat_v2"]);
  assert.deepEqual(compatibilityFlagsFor(["no_nodejs_compat"]), ["no_nodejs_compat"]);
});

test("PROJECT_MAIN exports the project's classes and the driver's handler", () => {
  assert.match(PROJECT_MAIN, /export \* from "\.\/project\.mjs"/);
  assert.match(PROJECT_MAIN, /export \{ default \} from "\.\/workerd-worker\.mjs"/);
  assert.match(PROJECT_MAIN, /globalThis\.worker = project\.default/);
});

test("bundleProject keeps builtins as imports, bare names aliased to node:", async (t) => {
  const dir = scratch(t);
  writeFileSync(
    join(dir, "index.ts"),
    'import { DurableObject } from "cloudflare:workers";\nimport { Buffer } from "buffer";\n' +
      "export class C extends DurableObject {}\nexport const b: string = Buffer.from(VERSION).toString();\n",
  );
  const out = await bundleProject(join(dir, "index.ts"), { VERSION: '"1.2"' });
  assert.match(out, /from "cloudflare:workers"/);
  assert.match(out, /from "node:buffer"/);
  assert.match(out, /export \{[^}]*\bC\b/);
  assert.match(out, /"1\.2"/, "wrangler's define is applied");
});

// --- Against the project's Miniflare ---------------------------------------

function writeProject(dir: string, { linkNodeModules = true } = {}): void {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ private: true, type: "module" }),
    "wrangler.jsonc": `{
  // comments are allowed, as in any wrangler.jsonc
  "name": "nb-fixture",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "vars": { "GREETING": "hello" },
  "kv_namespaces": [{ "binding": "KV", "id": "kv-local" }],
  "d1_databases": [{ "binding": "DB", "database_name": "db", "database_id": "local-db" }],
  "durable_objects": { "bindings": [{ "name": "COUNTER", "class_name": "Counter" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Counter"] }]
}
`,
    "src/index.ts": `import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async increment(): Promise<number> {
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
    await this.ctx.storage.put("n", n);
    return n;
  }
}
export default {
  async fetch(request: Request, env: { GREETING: string }): Promise<Response> {
    return new Response(env.GREETING + " from " + new URL(request.url).pathname);
  },
};
`,
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  if (linkNodeModules) symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
  mkdirSync(join(dir, "notebooks"), { recursive: true });
}

type Event = { stream: string; text: string } | { message: TargetMessage } | { exit: number | null; note?: string };

async function launch(t: { after(fn: () => void): void }, cwd: string) {
  const events: Event[] = [];
  const handlers: TargetEvents = {
    stream: (stream, text) => void events.push({ stream, text }),
    message: (message) => void events.push({ message }),
    exit: (exit, note) => void events.push({ exit, note }),
  };
  const target = await WorkerdTarget.launch(handlers, { cwd });
  t.after(() => target.kill());
  /** A cell's displayed value, as text. */
  const value = async (cell: string): Promise<string> => {
    const r = await target.evaluate(target.transform(cell, {}));
    if (r.exceptionDetails?.exception) throw new Error((await target.describeError(r.exceptionDetails.exception)).message);
    events.length = 0;
    await target.broadcastResult(1, r.result);
    const shown = events.find((e): e is { message: TargetMessage } => "message" in e && e.message.kind === "iopub");
    const data = shown?.message.kind === "iopub" ? shown.message.content.data : undefined;
    const text = (data as { "text/plain"?: string } | undefined)?.["text/plain"] ?? "";
    return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/^'|'$/g, "");
  };
  return { target, events, value };
}

test("cells get the project's bindings as env, and its worker", { skip }, async (t) => {
  const dir = scratch(t);
  writeProject(dir);
  const { target, value } = await launch(t, join(dir, "notebooks"));
  assert.match(target.versions.runtime, /^miniflare /);
  assert.match(target.notice ?? "", /env has COUNTER, DB, GREETING, KV; worker is its default export/);
  assert.equal(await value("env.GREETING"), "hello");
  assert.equal(await value("await env.KV.put('k', 'v1'); await env.KV.get('k')"), "v1");
  assert.equal(await value("const stub = env.COUNTER.get(env.COUNTER.idFromName('a')); await stub.increment()"), "1");
  assert.equal(await value("await stub.increment()"), "2");
  assert.equal(
    await value("await env.DB.exec('CREATE TABLE t (x)'); await env.DB.prepare('INSERT INTO t VALUES (?)').bind(7).run(); (await env.DB.prepare('SELECT x FROM t').first()).x"),
    "7",
  );
  assert.equal(await value("await (await worker.fetch(new Request('https://x/path'), env)).text()"), "hello from /path");
  assert.equal(await value("Object.keys(env).includes('TOKEN')"), "false", "the kernel's own bindings stay hidden");
});

test("project state persists across kernels, beside wrangler dev's", { skip }, async (t) => {
  const dir = scratch(t);
  writeProject(dir);
  const first = await launch(t, join(dir, "notebooks"));
  assert.equal(await first.value("await env.COUNTER.get(env.COUNTER.idFromName('p')).increment()"), "1");
  first.target.kill();
  await new Promise((r) => setTimeout(r, 500));
  const second = await launch(t, join(dir, "notebooks"));
  assert.equal(await second.value("await env.COUNTER.get(env.COUNTER.idFromName('p')).increment()"), "2");
  assert.ok(existsSync(join(dir, ".wrangler", "state", "cdp-kernel")));
  assert.ok(!existsSync(join(dir, ".wrangler", "state", "v3")), "wrangler dev's own state is untouched");
});

test("a project without wrangler installed runs on plain workerd, and says why", { skip }, async (t) => {
  const dir = scratch(t);
  writeProject(dir, { linkNodeModules: false });
  // The plain workerd comes from PATH, so name it explicitly here.
  const events: Event[] = [];
  const target = await WorkerdTarget.launch(
    { stream: () => {}, message: (message) => void events.push({ message }), exit: () => {} },
    { cwd: join(dir, "notebooks"), executable: join(REPO, "node_modules", ".bin", "workerd") },
  );
  t.after(() => target.kill());
  assert.match(target.notice ?? "", /couldn't load the Workers project.*wrangler isn't installed.*running without its bindings/);
  assert.match(target.versions.runtime, /^\d{4}-\d{2}-\d{2}$/);
});

test("interrupting a busy cell restarts the project's Miniflare, saying so", { skip }, async (t) => {
  const dir = scratch(t);
  writeProject(dir);
  const { target, events } = await launch(t, join(dir, "notebooks"));
  const pending = target.evaluate(target.transform("while (true) {}", {}));
  await new Promise((r) => setTimeout(r, 300));
  let exitedFirst = false;
  const outcome = pending.catch((err: unknown) => {
    exitedFirst = events.some((e) => "exit" in e);
    return err;
  });
  await target.interrupt();
  assert.ok((await outcome) instanceof Interrupted);
  assert.ok(exitedFirst);
  assert.deepEqual(events.find((e) => "exit" in e), { exit: null, note: RESTART_NOTE });
});
