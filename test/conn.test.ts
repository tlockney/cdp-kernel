import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConnectionInfo } from "../src/kernel.ts";

const ports = { shell_port: 1, control_port: 2, stdin_port: 3, iopub_port: 4, hb_port: 5 };

test("parseConnectionInfo fills defaults", () => {
  const info = parseConnectionInfo(JSON.stringify(ports));
  assert.deepEqual(info, {
    ip: "127.0.0.1",
    key: "",
    transport: "tcp",
    signature_scheme: "hmac-sha256",
    ...ports,
  });
});

test("parseConnectionInfo keeps provided ip and key", () => {
  const info = parseConnectionInfo(
    JSON.stringify({ ...ports, ip: "10.0.0.2", key: "abc", transport: "tcp", signature_scheme: "hmac-sha256" }),
  );
  assert.equal(info.ip, "10.0.0.2");
  assert.equal(info.key, "abc");
});

test("parseConnectionInfo rejects a missing port", () => {
  for (const name of Object.keys(ports)) {
    const partial: Record<string, number> = { ...ports };
    delete partial[name];
    assert.throws(() => parseConnectionInfo(JSON.stringify(partial)), new RegExp(`missing ${name}`));
  }
});

test("parseConnectionInfo rejects non-numeric ports and non-objects", () => {
  assert.throws(() => parseConnectionInfo(JSON.stringify({ ...ports, hb_port: "5" })), /missing hb_port/);
  assert.throws(() => parseConnectionInfo("null"), /not an object/);
  assert.throws(() => parseConnectionInfo("3"), /not an object/);
});

test("parseConnectionInfo rejects a non-string ip or key", () => {
  assert.throws(() => parseConnectionInfo(JSON.stringify({ ...ports, ip: 127 })), /ip is not a string/);
  assert.throws(() => parseConnectionInfo(JSON.stringify({ ...ports, key: 42 })), /key is not a string/);
});

test("parseConnectionInfo rejects non-tcp transport", () => {
  assert.throws(() => parseConnectionInfo(JSON.stringify({ ...ports, transport: "ipc" })), /unsupported transport/);
});

test("parseConnectionInfo rejects unknown signature scheme only when a key is set", () => {
  assert.throws(
    () => parseConnectionInfo(JSON.stringify({ ...ports, key: "k", signature_scheme: "hmac-md5" })),
    /unsupported signature scheme/,
  );
  assert.doesNotThrow(() => parseConnectionInfo(JSON.stringify({ ...ports, key: "", signature_scheme: "hmac-md5" })));
});
