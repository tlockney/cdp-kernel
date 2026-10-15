// The in-process request handler (runtime/evaluator.mjs), with a fake
// __cdpk and evaluator. Runs under Node; the channel itself is covered by
// test/bun-target.test.ts against a real Bun.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler, type EvaluatorShim, propertyNames } from "../runtime/evaluator.mjs";

function harness(evaluate: (code: string) => unknown) {
  const broadcast: { count: number; value: unknown }[] = [];
  const comms: string[] = [];
  let barrier = 0;
  const shim: EvaluatorShim = {
    broadcastResult: (count, value) => void broadcast.push({ count, value }),
    describeError: (value) =>
      JSON.stringify(value instanceof Error ? { name: value.name, message: value.message, stack: "s" } : { name: "Error", message: String(value), stack: "" }),
    commDispatch: (msgType) => {
      comms.push(msgType);
      if (msgType === "comm_close") return Promise.reject(new RangeError("handler broke"));
      return Promise.resolve(msgType === "comm_open");
    },
    barrier: () => ++barrier,
    inspectPath: (path, detail) => (path === "known" ? `about known, detail ${detail}` : null),
  };
  return { handle: createHandler(shim, evaluate), broadcast, comms };
}

test("eval returns a handle for the result, which broadcast then displays", async () => {
  const value = { big: "object" };
  const { handle, broadcast } = harness(() => Promise.resolve([value]));
  const reply = await handle({ op: "eval", code: "x" });
  const result = reply.result as { type: string; objectId: string };
  assert.equal(result.type, "object");
  await handle({ op: "broadcast", count: 3, handle: result.objectId });
  assert.deepEqual(broadcast, [{ count: 3, value }]);
  assert.equal(broadcast[0].value, value, "the value itself, not a copy");
});

test("eval reports types like CDP, null included", async () => {
  for (const [value, type] of [[null, "object"], [1, "number"], ["s", "string"], [() => 1, "function"]] as const) {
    const { handle } = harness(() => Promise.resolve([value]));
    assert.equal(((await handle({ op: "eval", code: "" })).result as { type: string }).type, type);
  }
});

test("eval of a cell without a trailing expression has no value", async () => {
  const { handle } = harness(() => Promise.resolve(undefined));
  assert.deepEqual(await handle({ op: "eval", code: "" }), { result: { type: "undefined" } });
});

test("a rejected or thrown cell becomes exceptionDetails with a describable handle", async () => {
  for (const evaluate of [() => Promise.reject(new TypeError("boom")), () => {
    throw new TypeError("boom");
  }]) {
    const { handle } = harness(evaluate);
    const reply = await handle({ op: "eval", code: "" });
    const details = reply.exceptionDetails as { exception: { objectId: string } };
    const described = await handle({ op: "describe", handle: details.exception.objectId });
    assert.deepEqual(JSON.parse(String(described.value)), { name: "TypeError", message: "boom", stack: "s" });
  }
});

test("handles are dropped once used, and at the next eval", async () => {
  const { handle, broadcast } = harness(() => Promise.resolve([1]));
  const first = ((await handle({ op: "eval", code: "" })).result as { objectId: string }).objectId;
  await handle({ op: "eval", code: "" });
  await handle({ op: "broadcast", count: 1, handle: first });
  assert.deepEqual(broadcast, [{ count: 1, value: undefined }]);
});

test("comm reports whether a handler took it, or the error it threw", async () => {
  const { handle, comms } = harness(() => undefined);
  const args = { content: {}, metadata: {}, buffers: [] };
  assert.deepEqual(await handle({ op: "comm", msgType: "comm_open", ...args }), { handled: true });
  assert.deepEqual(await handle({ op: "comm", msgType: "comm_msg", ...args }), { handled: false });
  assert.deepEqual(await handle({ op: "comm", msgType: "comm_close", ...args }), {
    error: { name: "RangeError", message: "handler broke", stack: "s" },
  });
  assert.deepEqual(comms, ["comm_open", "comm_msg", "comm_close"]);
});

test("props lists names for completion, and nothing when the expression throws", async () => {
  const { handle } = harness((code) => {
    if (code === "(boom)") throw new ReferenceError("boom is not defined");
    return { own: 1 };
  });
  const names = (await handle({ op: "props", expr: "obj" })).names as string[];
  assert.ok(names.includes("own") && names.includes("hasOwnProperty"), names.join());
  assert.deepEqual(await handle({ op: "props", expr: "boom" }), { names: [] });
});

test("barrier and ping answer immediately", async () => {
  const { handle } = harness(() => undefined);
  assert.deepEqual(await handle({ op: "barrier" }), { value: 1 });
  assert.deepEqual(await handle({ op: "ping" }), {});
});

test("an unknown request is an error", async () => {
  const { handle } = harness(() => undefined);
  await assert.rejects(handle({ op: "nope" }), /unknown request "nope"/);
});

test("propertyNames walks the prototype chain and boxes primitives", () => {
  class Base {
    inherited() {}
  }
  const names = propertyNames(Object.assign(new Base(), { own: 1 }));
  assert.ok(names.includes("own") && names.includes("inherited") && names.includes("toString"));
  assert.ok(propertyNames("str").includes("padStart"));
  assert.deepEqual(propertyNames(null), []);
  assert.deepEqual(propertyNames(undefined), []);
});

test("inspect asks the shim to describe a path (#10)", async () => {
  const { handle } = harness(() => undefined);
  assert.deepEqual(await handle({ op: "inspect", path: "known", detail: 1 }), { text: "about known, detail 1" });
  assert.deepEqual(await handle({ op: "inspect", path: "unknown" }), { text: null });
});

test("props resolves the path through the shim when it can, so getters don't run", async () => {
  let evaluated = 0;
  const shim: EvaluatorShim = {
    broadcastResult() {},
    describeError: () => "{}",
    commDispatch: () => Promise.resolve(false),
    barrier: () => 0,
    inspectPath: () => null,
    resolvePath: (path) =>
      path === "obj"
        ? { found: true, value: { a: 1 } }
        : path === "lazy"
        ? { found: true, accessor: true, name: "lazy" }
        : { found: false },
  };
  const handle = createHandler(shim, () => {
    evaluated++;
    return {};
  });
  assert.ok(((await handle({ op: "props", expr: "obj" })).names as string[]).includes("a"));
  assert.deepEqual(await handle({ op: "props", expr: "lazy" }), { names: [] });
  assert.deepEqual(await handle({ op: "props", expr: "missing" }), { names: [] });
  assert.equal(evaluated, 0, "nothing was evaluated");
});
