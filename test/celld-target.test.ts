// The celld target (#25): config generation and bundling as units, then the
// target against a real celld. Set CELLD to its path, or install it in
// ~/.local/bin (celld's installer); the real-celld tests skip otherwise.
// test/e2e.py's celld variants cover the kernel end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { bundleDriver, celldConfig, celldVersionOf, findCelld, freePort, launchCelld, PROJECT_KEYS } from "../src/celld-target.ts";
import { restartNote } from "../src/workerd-target.ts";
import { Interrupted, type TargetEvents, type TargetMessage } from "../src/target.ts";

const CELLD = process.env.CELLD ?? findCelld();
const skip = spawnSync(CELLD, ["--version"], { stdio: "ignore" }).status !== 0;
const RUNTIME = fileURLToPath(new URL("../runtime/", import.meta.url));

function scratch(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "cdpk-celld-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const META = { url: "file:///nb/$cdpk$repl.mjs", dirname: "/nb", filename: "/nb/$cdpk$repl.mjs" };

test("celldConfig runs the pre-built driver, with the token and meta as vars", () => {
  const config = celldConfig(null, { token: "t", meta: META });
  assert.equal(config.main, "driver.mjs");
  assert.equal(config.no_bundle, true);
  assert.deepEqual(config.vars, { TOKEN: "t", META: JSON.stringify(META) });
});

test("celldConfig keeps a project's bindings and drops what celld would apply to the driver", () => {
  const project = {
    name: "app",
    main: "src/index.ts",
    compatibility_date: "2026-01-02",
    vars: { GREETING: "hi" },
    kv_namespaces: [{ binding: "KV", id: "kv" }],
    durable_objects: { bindings: [{ name: "C", class_name: "C" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["C"] }],
    assets: { directory: "public" },
    triggers: { crons: ["* * * * *"] },
    define: { X: "1" },
  };
  const config = celldConfig(project, { token: "t", meta: META });
  for (const key of ["kv_namespaces", "durable_objects", "migrations"]) assert.deepEqual(config[key], project[key as keyof typeof project]);
  assert.equal(config.compatibility_date, "2026-01-02");
  assert.equal(config.name, "cdpk");
  assert.equal(config.main, "driver.mjs");
  assert.deepEqual(config.vars, { GREETING: "hi", TOKEN: "t", META: JSON.stringify(META) });
  for (const key of ["assets", "triggers", "define"]) assert.equal(config[key], undefined, key);
  assert.ok(PROJECT_KEYS.includes("d1_databases") && PROJECT_KEYS.includes("workflows"));
});

test("findCelld prefers the installer's ~/.local/bin, then PATH", (t) => {
  const home = scratch(t);
  assert.equal(findCelld(home), "celld");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(join(home, ".local", "bin", "celld"), "");
  assert.equal(findCelld(home), join(home, ".local", "bin", "celld"));
});

test("celldVersionOf reads celld --version", () => {
  assert.equal(celldVersionOf("celld 0.6.2\n"), "0.6.2");
  assert.equal(celldVersionOf("nothing"), "");
});

test("freePort finds a usable loopback port", async () => {
  const port = await freePort();
  assert.ok(port > 0 && port < 65536);
});

test("bundleDriver makes one module: the driver, and a project's exports", async (t) => {
  const plain = await bundleDriver(RUNTIME);
  assert.match(plain, /export\s*\{[^}]*\bdefault\b/);
  assert.doesNotMatch(plain, /from "\.\/display\.mjs"/, "the driver's modules are inlined");
  const dir = scratch(t);
  writeFileSync(
    join(dir, "index.ts"),
    'import { DurableObject } from "cloudflare:workers";\nexport class Counter extends DurableObject {}\nexport default { fetch: () => new Response(NAME) };\n',
  );
  const withProject = await bundleDriver(RUNTIME, join(dir, "index.ts"), { NAME: '"named"' });
  assert.match(withProject, /\bCounter\b/);
  assert.match(withProject, /globalThis\.worker = /);
  assert.match(withProject, /"named"/);
  assert.match(withProject, /from "cloudflare:workers"/);
});

// --- Against a real celld ---------------------------------------------------

type Event = { stream: string; text: string } | { message: TargetMessage } | { exit: number | null; note?: string };

async function launch(t: { after(fn: () => void): void }, cwd: string, executable = CELLD) {
  const events: Event[] = [];
  const handlers: TargetEvents = {
    stream: (stream, text) => void events.push({ stream, text }),
    message: (message) => void events.push({ message }),
    exit: (exit, note) => void events.push({ exit, note }),
  };
  const before = new Set(celldPids());
  const target = await launchCelld(handlers, { cwd, executable });
  const own = celldPids().filter((pid) => !before.has(pid));
  // Wait out celld's graceful stop, which can take seconds, so this launch's
  // processes don't outlive the test into the next one's check (#93).
  t.after(async () => {
    target.kill();
    assert.deepEqual(await celldGone(own), [], "celld exits after kill()");
  });
  /** A cell's value, carried back as an error message to skip display plumbing. */
  const value = async (cell: string): Promise<string> => {
    const r = await target.evaluate(target.transform(`throw new Error(String(await (async () => { ${cell} })()))`, {}));
    return r.exceptionDetails?.exception ? (await target.describeError(r.exceptionDetails.exception)).message : "no value";
  };
  return { target, events, value };
}

function celldProcesses(): string {
  return execSync("ps -axo command | grep -v grep | grep -E '(^|/)celld (dev|--no-control-plane)' || true", { encoding: "utf8" }).trim();
}

function celldPids(): number[] {
  return execSync("ps -axo pid=,command= | grep -v grep | grep -E '(^|/)celld (dev|--no-control-plane)' || true", { encoding: "utf8" })
    .split("\n").filter((line) => line.trim()).map((line) => parseInt(line, 10));
}

/**
 * The given celld processes still running once they're gone or a deadline
 * passes. It's past the 3 s after which a graceful stop is forced.
 */
async function celldGone(pids: number[], ms = 10_000): Promise<number[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const running = new Set(celldPids());
    const left = pids.filter((pid) => running.has(pid));
    if (left.length === 0 || Date.now() >= deadline) return left;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function writeProject(dir: string, config: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "wrangler.jsonc"), config);
  writeFileSync(
    join(dir, "src", "index.ts"),
    'import { DurableObject } from "cloudflare:workers";\n' +
      "export class Counter extends DurableObject {\n" +
      "  async increment(): Promise<number> {\n" +
      '    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;\n' +
      '    await this.ctx.storage.put("n", n);\n' +
      "    return n;\n" +
      "  }\n" +
      "}\n" +
      'export default { fetch: () => new Response("project") };\n',
  );
}

const PROJECT_CONFIG = `{
  // comments, as in any wrangler.jsonc
  "name": "fixture",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "vars": { "GREETING": "hello" },
  "kv_namespaces": [{ "binding": "KV", "id": "kv" }],
  "durable_objects": { "bindings": [{ "name": "COUNTER", "class_name": "Counter" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Counter"] }]
}
`;

test("cells run in celld's session: timers, randomness, imports and state", { skip }, async (t) => {
  const dir = scratch(t);
  const { target, events, value } = await launch(t, dir);
  assert.match(target.versions.runtime, /^celld \d/);
  assert.equal(target.runtime, "celld");
  assert.equal(await value("await new Promise((r) => setTimeout(r, 5)); return crypto.randomUUID().length"), "36");
  await target.evaluate(target.transform("const a: number = 41; globalThis.res = new Response('carried')", {}));
  assert.equal(await value("return a + 1"), "42");
  assert.equal(await value("return await res.text()"), "carried", "an I/O object from an earlier cell");
  assert.equal(await value("return (await import('node:path')).join('a', 'b')"), "a/b");
  await target.evaluate(target.transform("console.log('from celld')", {}));
  assert.ok(events.some((e) => "stream" in e && e.text === "from celld\n"));
});

test("a project's bindings, its Durable Objects, and state beside celld dev's", { skip }, async (t) => {
  const dir = scratch(t);
  writeProject(dir, PROJECT_CONFIG);
  const first = await launch(t, dir);
  assert.match(first.target.notice ?? "", /env has COUNTER, GREETING, KV; worker is its default export/);
  assert.equal(await first.value("return env.GREETING"), "hello");
  assert.equal(await first.value("await env.KV.put('k', 'v'); return await env.KV.get('k')"), "v");
  await first.target.evaluate(first.target.transform("const stub = env.COUNTER.get(env.COUNTER.idFromName('t'))", {}));
  assert.equal(await first.value("return await stub.increment()"), "1");
  assert.equal(await first.value("return await (await worker.fetch(new Request('https://x/'))).text()"), "project");
  assert.equal(await first.value("return Object.keys(env).includes('TOKEN')"), "false");
  first.target.kill();
  // Removed once celld dev exits; a graceful stop can take a few seconds
  // (a fixed 1.5 s wait was flaky in CI).
  const config = join(dir, ".celld", "cdp-kernel", "wrangler.jsonc");
  for (let i = 0; i < 100 && existsSync(config); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!existsSync(config), "the config with the token is removed");
  const second = await launch(t, dir);
  assert.match(second.target.notice ?? "", /env has COUNTER, GREETING, KV/, "the second launch has the project too");
  assert.equal(await second.value("return await env.COUNTER.get(env.COUNTER.idFromName('t')).increment()"), "2");
  assert.ok(existsSync(join(dir, ".celld", "cdp-kernel", ".celld", "dev")));
  assert.ok(!existsSync(join(dir, ".celld", "dev")), "celld dev's own state is untouched");
});

test("a wrangler.toml project is reported, and the driver runs alone", { skip }, async (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, "wrangler.toml"), 'name = "x"\n');
  const { target, value } = await launch(t, dir);
  assert.match(target.notice ?? "", /couldn't load the celld project.*not wrangler\.toml.*running without its bindings/);
  assert.equal(await value("return 1 + 1"), "2");
});

test("interrupting a waiting cell keeps state; a busy one stops celld entirely", { skip }, async (t) => {
  const dir = scratch(t);
  const { target, events, value } = await launch(t, dir);
  await target.evaluate(target.transform("globalThis.kept = 'yes'", {}));
  const waiting = target.evaluate(target.transform("await new Promise(() => {})", {}));
  await new Promise((r) => setTimeout(r, 200));
  await target.interrupt();
  await assert.rejects(waiting, Interrupted);
  assert.equal(await value("return kept"), "yes");

  const busy = target.evaluate(target.transform("while (true) {}", {}));
  await new Promise((r) => setTimeout(r, 300));
  let exitedFirst = false;
  const outcome = busy.catch((err: unknown) => {
    exitedFirst = events.some((e) => "exit" in e);
    return err;
  });
  await target.interrupt();
  assert.ok((await outcome) instanceof Interrupted);
  assert.ok(exitedFirst);
  assert.deepEqual(events.find((e) => "exit" in e), { exit: null, note: restartNote("celld") });
  // Killed, but a slow runner can take a moment to reap them (#93).
  await celldGone(celldPids());
  assert.equal(celldProcesses(), "", "no celld node is left behind");
});

test("a start that loses a port race is retried, and keeps the project", { skip }, async (t) => {
  const dir = scratch(t);
  writeProject(dir, PROJECT_CONFIG);
  // celld's first `dev` fails as its node does when another process takes
  // its listener port first (#54); later ones run the real celld.
  const tries = join(dir, "tries");
  const fake = join(dir, "celld-racing");
  writeFileSync(
    fake,
    `#!/bin/sh\nif [ "$1" = dev ] && [ ! -e '${tries}' ]; then\n  touch '${tries}'\n` +
      `  echo 'Error: bind --listen 127.0.0.1:1' >&2\n  echo '    Address already in use (os error 98)' >&2\n  exit 1\nfi\n` +
      `exec '${CELLD}' "$@"\n`,
  );
  chmodSync(fake, 0o755);
  const { target, value } = await launch(t, dir, fake);
  assert.ok(existsSync(tries), "the first start failed");
  assert.match(target.notice ?? "", /env has COUNTER, GREETING, KV/);
  assert.equal(await value("return env.GREETING"), "hello");
});
