// Kernel subshells (JEP 91, #417): a comm message sent on a subshell
// reaches its handler while a cell on the main shell waits for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { KernelCore } from "../src/kernel-core.ts";
import { BunTarget } from "../src/bun-target.ts";
import { Target } from "../src/target.ts";
import type { KernelTarget, TargetEvents } from "../src/target-api.ts";
import { FakeChannels } from "./fake-channels.ts";
import { hasBun } from "./bun.ts";

const hasDeno = spawnSync("deno", ["--version"]).status === 0;

function kernel(launch: (events: TargetEvents) => Promise<KernelTarget>) {
  const channels = new FakeChannels();
  let target: KernelTarget | null = null;
  const core = new KernelCore({
    runtime: "test",
    version: "0",
    channels,
    launchTarget: async (events) => (target = await launch(events)),
    log: () => {},
    exit: () => {},
  });
  void core.run();
  return { channels, core, stop: () => (core.stopping(), target?.kill()) };
}

async function createSubshell(channels: FakeChannels): Promise<string> {
  const id = channels.push("control", "create_subshell_request");
  const reply = await channels.replyOf("create_subshell_reply", id);
  assert.equal(reply.content.status, "ok");
  assert.equal(typeof reply.content.subshell_id, "string");
  return reply.content.subshell_id as string;
}

test("kernel_info lists kernel subshells; create, list and delete follow JEP 91", async () => {
  const { channels, stop } = kernel(() => new Promise<KernelTarget>(() => {}));
  try {
    const info = channels.push("shell", "kernel_info_request");
    const features = (await channels.replyOf("kernel_info_reply", info)).content.supported_features;
    assert.ok(Array.isArray(features) && features.includes("kernel subshells"), String(features));

    const a = await createSubshell(channels);
    const b = await createSubshell(channels);
    assert.notEqual(a, b);
    let list = channels.push("control", "list_subshell_request");
    assert.deepEqual((await channels.replyOf("list_subshell_reply", list)).content, { status: "ok", subshell_id: [a, b] });

    const del = channels.push("control", "delete_subshell_request", { subshell_id: a });
    assert.deepEqual((await channels.replyOf("delete_subshell_reply", del)).content, { status: "ok" });
    list = channels.push("control", "list_subshell_request");
    assert.deepEqual((await channels.replyOf("list_subshell_reply", list)).content.subshell_id, [b]);

    const again = channels.push("control", "delete_subshell_request", { subshell_id: a });
    assert.equal((await channels.replyOf("delete_subshell_reply", again)).content.status, "error");

    // A message for a subshell that doesn't exist is answered with an error.
    const lost = channels.push("shell", "kernel_info_request", {}, { subshell_id: a });
    assert.equal((await channels.replyOf("kernel_info_reply", lost)).content.status, "error");
    // A live subshell answers while the main shell waits on a target that never starts.
    channels.push("shell", "execute_request", { code: "1" });
    const onB = channels.push("shell", "kernel_info_request", {}, { subshell_id: b });
    assert.equal((await channels.replyOf("kernel_info_reply", onB)).content.status, "ok");
  } finally {
    stop();
  }
});

/** A target whose steps the test releases, to hold the kernel at a chosen point. */
function gatedTarget() {
  const gate = () => {
    let open!: () => void;
    let reached!: () => void;
    const at = new Promise<void>((r) => (reached = r));
    const released = new Promise<void>((r) => (open = r));
    return { at, open, wait: () => (reached(), released) };
  };
  const release = gate();
  const comm = gate();
  const target = {
    runtime: "node",
    versions: { runtime: "0", engine: "0" },
    transform: (code: string) => code,
    evaluate: async () => ({
      result: { type: "undefined" },
      exceptionDetails: { exceptionId: 1, text: "Uncaught boom", lineNumber: 0, columnNumber: 0 },
    }),
    releaseResults: () => release.wait(),
    dispatchComm: async () => (await comm.wait(), { handled: true }),
    flush: async () => {},
    interrupt: async () => {},
    kill: () => {},
  } as unknown as KernelTarget;
  return { target, release, comm };
}

test("a failed cell's error keeps its parent when a subshell comm runs before it is sent", async () => {
  const { target, release, comm } = gatedTarget();
  const { channels, stop } = kernel(async () => target);
  try {
    const subshell = await createSubshell(channels);
    const cell = channels.push("shell", "execute_request", { code: "boom()", silent: false });
    await release.at;
    // The cell has ended; its error isn't sent yet.
    channels.push("shell", "comm_msg", { comm_id: "c", data: {} }, { subshell_id: subshell });
    await comm.at;
    release.open();
    comm.open();
    assert.equal((await channels.replyOf("execute_reply", cell)).content.status, "error");
    const error = channels.published.find((m) => m.header.msg_type === "error");
    assert.equal(error?.parentHeader.msg_id, cell);
  } finally {
    stop();
  }
});

test("requests for a missing or deleted subshell are answered", async () => {
  const { target, release, comm } = gatedTarget();
  release.open();
  const { channels, stop } = kernel(async () => target);
  try {
    const idleFor = async (id: string) => {
      while (!channels.published.some((m) => m.header.msg_type === "status" && m.parentHeader.msg_id === id && m.content.execution_state === "idle")) {
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    // A cell on an unknown subshell is refused, not run.
    const cell = channels.push("shell", "execute_request", { code: "1" }, { subshell_id: "nope" });
    assert.equal((await channels.replyOf("execute_reply", cell)).content.ename, "SubshellNotFound");
    await idleFor(cell);
    // A comm_open on one is closed, as for an unknown target.
    const open = channels.push("shell", "comm_open", { comm_id: "lost", target_name: "t", data: {} }, { subshell_id: "nope" });
    await idleFor(open);
    assert.ok(channels.published.some((m) => m.header.msg_type === "comm_close" && m.parentHeader.msg_id === open));

    // Requests queued on a subshell when it is deleted get an error.
    const subshell = await createSubshell(channels);
    channels.push("shell", "comm_msg", { comm_id: "c", data: {} }, { subshell_id: subshell });
    await comm.at;
    const queued = channels.push("shell", "kernel_info_request", {}, { subshell_id: subshell });
    const del = channels.push("control", "delete_subshell_request", { subshell_id: subshell });
    assert.equal((await channels.replyOf("delete_subshell_reply", del)).content.status, "ok");
    assert.equal((await channels.replyOf("kernel_info_reply", queued)).content.status, "error");
    await idleFor(queued);
    comm.open();
  } finally {
    stop();
  }
});

// The cell announces a comm and waits for the frontend's answer on it.
const AWAIT_REPLY = `
const comm = jupyter.comm.open("ask", {});
const answer = await new Promise((resolve) => comm.onMsg((m) => resolve(m.data.answer)));
answer * 2`;

const targets: Record<string, { launch: (events: TargetEvents) => Promise<KernelTarget>; skip: string | false }> = {
  node: { launch: (events) => Target.launch("node", events), skip: false },
  deno: { launch: (events) => Target.launch("deno", events), skip: !hasDeno && "deno not on PATH" },
  bun: { launch: (events) => BunTarget.launch(events), skip: !hasBun() && "bun not on PATH" },
};

for (const [name, { launch, skip }] of Object.entries(targets)) {
  test(`${name}: a comm message on a subshell reaches a cell awaiting it`, { skip }, async () => {
    const { channels, stop } = kernel(launch);
    try {
      const subshell = await createSubshell(channels);
      const cell = channels.push("shell", "execute_request", { code: AWAIT_REPLY, silent: false });
      let open: { content: Record<string, unknown> } | undefined;
      while (!(open = channels.published.find((m) => m.header.msg_type === "comm_open"))) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const commId = String(open.content.comm_id);
      const msg = channels.push("shell", "comm_msg", { comm_id: commId, data: { answer: 21 } }, { subshell_id: subshell });

      const reply = await channels.replyOf("execute_reply", cell);
      assert.equal(reply.content.status, "ok", JSON.stringify(reply.content));
      const result = channels.published.find((m) => m.header.msg_type === "execute_result" && m.parentHeader.msg_id === cell);
      assert.match((result?.content.data as Record<string, string>)["text/plain"], /42/);
      // The comm message's own busy/idle went out, with its parent.
      const idle = channels.published.find((m) =>
        m.header.msg_type === "status" && m.parentHeader.msg_id === msg && m.content.execution_state === "idle"
      );
      assert.ok(idle, "no idle for the comm message");
    } finally {
      stop();
    }
  });
}
