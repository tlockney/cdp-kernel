import { test } from "node:test";
import assert from "node:assert/strict";
import { asEvaluateResult } from "../src/cdp.ts";

test("asEvaluateResult accepts an evaluate reply, with or without exceptionDetails", () => {
  const ok = { result: { type: "number", value: 1 } };
  assert.deepEqual(asEvaluateResult(ok), ok);
  const thrown = { result: { type: "object" }, exceptionDetails: { text: "Uncaught", lineNumber: 0, columnNumber: 0 } };
  assert.deepEqual(asEvaluateResult(thrown), thrown);
  // The Bun and workerd drivers' shape for a throw.
  const details = { text: "Uncaught", lineNumber: 0, columnNumber: 0, exception: { type: "object", objectId: "h1" } };
  assert.deepEqual(asEvaluateResult({ kind: "reply", id: 1, exceptionDetails: details }), {
    result: { type: "undefined" },
    exceptionDetails: details,
  });
});

test("asEvaluateResult rejects a reply without a RemoteObject", () => {
  assert.throws(() => asEvaluateResult({}), /malformed evaluate result/);
  assert.throws(() => asEvaluateResult({ result: 1 }), /malformed evaluate result/);
  assert.throws(() => asEvaluateResult({ result: { type: "number" }, exceptionDetails: "x" }), /malformed evaluate result/);
  assert.throws(() => asEvaluateResult({ exceptionDetails: {} }), /malformed evaluate result/);
});
