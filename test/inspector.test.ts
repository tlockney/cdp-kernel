// A target's inspector must not advertise its WebSocket URL (#22).
//
// The CDP WebSocket has no authentication: whoever connects can run code as
// the kernel's user, bypassing the HMAC signing on the Jupyter channels. By
// default Node and Deno list the URL, with its random id, at
// http://127.0.0.1:<port>/json/list for any local process to read.
// --inspect-publish-uid=stderr publishes it only on the target's own stderr,
// which is where the host reads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchCommand, type RuntimeName } from "../src/target.ts";

const BOOTSTRAP = fileURLToPath(new URL("../runtime/bootstrap.mjs", import.meta.url));
const hasDeno = spawnSync("deno", ["--version"]).status === 0;

test("launchCommand publishes the inspector URL only on stderr", () => {
  for (const runtime of ["node", "deno"] as const) {
    assert.ok(launchCommand(runtime, BOOTSTRAP).args.includes("--inspect-publish-uid=stderr"), runtime);
  }
  const inProject = launchCommand("deno", BOOTSTRAP, { denoConfig: "/p/deno.json" });
  assert.ok(inProject.args.includes("--inspect-publish-uid=stderr"));
});

async function listedInspectors(runtime: RuntimeName): Promise<{ wsUrl: string; listing: string }> {
  const { cmd, args } = launchCommand(runtime, BOOTSTRAP);
  const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
  try {
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let banner = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        banner += chunk;
        const m = /ws:\/\/\S+/.exec(banner);
        if (m) resolve(m[0]);
      });
      child.once("exit", (code) => reject(new Error(`${cmd} exited (${code}): ${banner}`)));
    });
    const port = new URL(wsUrl).port;
    // What any local process sees: the inspector's discovery endpoints.
    const bodies: string[] = [];
    for (const path of ["/json/list", "/json"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`).catch(() => null);
      bodies.push(res ? await res.text() : "");
    }
    return { wsUrl, listing: bodies.join("\n") };
  } finally {
    child.kill();
  }
}

for (const runtime of ["node", "deno"] as const) {
  test(`a ${runtime} target's inspector URL isn't discoverable over HTTP`, {
    skip: runtime === "deno" && !hasDeno ? "deno not on PATH" : false,
  }, async () => {
    const { wsUrl, listing } = await listedInspectors(runtime);
    const id = new URL(wsUrl).pathname.slice(1);
    assert.ok(id.length >= 32, `expected a random id in ${wsUrl}`);
    assert.ok(!listing.includes(id), `inspector id leaked via /json:\n${listing}`);
  });
}
