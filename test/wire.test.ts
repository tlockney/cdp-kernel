import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { decodeMessage, DELIMITER, encodeMessage, sign, verify } from "../src/wire.ts";

const ENC = new TextEncoder();

test("sign matches HMAC-SHA256 hex over concatenated parts", () => {
  const parts = [ENC.encode("a"), ENC.encode("bc"), ENC.encode("{}")];
  const expected = createHmac("sha256", "secret").update("abc{}").digest("hex");
  assert.equal(sign("secret", parts), expected);
});

test("empty key gives empty signature and verify passes", () => {
  const parts = [ENC.encode("x")];
  assert.equal(sign("", parts), "");
  assert.equal(verify("", parts, "anything"), true);
});

test("verify accepts the right signature and rejects bad ones", () => {
  const parts = [ENC.encode("hello")];
  const good = sign("k", parts);
  assert.equal(verify("k", parts, good), true);
  assert.equal(verify("k", parts, good.toUpperCase()), true);
  assert.equal(verify("k", parts, sign("other", parts)), false);
  assert.equal(verify("k", parts, "zz" + good.slice(2)), false); // non-hex
  assert.equal(verify("k", parts, good.slice(0, -1)), false); // odd length
  assert.equal(verify("k", parts, good.slice(0, -2)), false); // shorter
  assert.equal(verify("k", parts, good + "00"), false); // longer
  assert.equal(verify("k", parts, ""), false);
});

test("encodeMessage then decodeMessage round-trips", () => {
  const identities = [ENC.encode("peer-1"), ENC.encode("peer-2")];
  const buffers = [new Uint8Array([1, 2, 3]), new Uint8Array([4])];
  const parentHeader = { msg_id: "parent", msg_type: "execute_request" };
  const frames = encodeMessage("sess", "key", "execute_reply", { status: "ok" }, {
    identities,
    parentHeader,
    metadata: { m: 1 },
    buffers,
  });
  const msg = decodeMessage(frames);
  assert.deepEqual(msg.identities, identities);
  assert.deepEqual(msg.buffers, buffers);
  assert.equal(msg.header.msg_type, "execute_reply");
  assert.equal(msg.header.session, "sess");
  assert.deepEqual(msg.parentHeader, parentHeader);
  assert.deepEqual(msg.metadata, { m: 1 });
  assert.deepEqual(msg.content, { status: "ok" });
  assert.equal(msg.signedParts.length, 4);
  assert.equal(verify("key", msg.signedParts, msg.sig), true);
  assert.equal(verify("other", msg.signedParts, msg.sig), false);
});

test("encodeMessage without key has empty signature frame", () => {
  const msg = decodeMessage(encodeMessage("s", "", "status", {}));
  assert.equal(msg.sig, "");
  assert.deepEqual(msg.identities, []);
});

test("decodeMessage throws without a delimiter", () => {
  const frames = [ENC.encode("a"), ENC.encode("b")];
  assert.throws(() => decodeMessage(frames), /delimiter/);
});

test("decodeMessage throws when too few frames follow the delimiter", () => {
  assert.throws(() => decodeMessage([DELIMITER, ENC.encode("sig"), ENC.encode("{}")]), /delimiter/);
});

test("decodeMessage throws on non-object JSON frames", () => {
  const good = encodeMessage("s", "", "status", {});
  for (const bad of ["[]", "1", "null", '"str"']) {
    const frames = [...good];
    frames[3] = ENC.encode(bad); // parent_header
    assert.throws(() => decodeMessage(frames), /JSON object/, bad);
  }
});

test("decodeMessage throws on a header without msg_id/msg_type", () => {
  const frames = [...encodeMessage("s", "", "status", {})];
  frames[2] = ENC.encode("{}");
  assert.throws(() => decodeMessage(frames), /header/);
});
