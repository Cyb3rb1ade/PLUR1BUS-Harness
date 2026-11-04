// Protocol and tool boundaries share the live registry; metadata names are never registered just for being references.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createSecretRedaction, redactProtocolOutput, redactProtocolValue } from "../../src/secrets/redaction.ts";
import { modelToolError } from "../../src/toolcall/model-tool-error.ts";
import { dispatcherProbe } from "./fixtures/dispatcher.ts";

for (const target of ["mcp", "a2a"] as const) test(`${target} masks nested escape spellings without concealing public reference names`, () => {
  const registry = createSecretRedaction();
  const secret = `${randomUUID()}:"\\/é`;
  registry.register(secret, "fixture");
  const text = JSON.stringify({ ordinary: secret }).replaceAll("/", "\\/");
  const output = redactProtocolOutput(text, target, registry);
  assert.ok(output.includes("[REDACTED:secret]"));
  assert.ok(!output.includes(JSON.stringify(secret).slice(1, -1)));
  const value = redactProtocolValue({ ordinary: text, reference: "fixture.reference" }, target, registry);
  assert.equal(value.reference, "fixture.reference");
  assert.ok(value.ordinary.includes("[REDACTED:secret]"));
});

test("registry forms are shared across protocol sinks and dispatcher and ignore membership ordering or pin-only changes", async t => {
  const secret = randomUUID();
  const registry = createSecretRedaction();
  registry.register(secret, "fixture");
  let derived = 0;
  const original = Buffer.from;
  t.mock.method(Buffer, "from", (...args: unknown[]) => {
    if (args[0] === secret) derived++;
    return Reflect.apply(original, Buffer, args) as ReturnType<typeof Buffer.from>;
  });
  const forms = registry.forms();
  assert.equal(redactProtocolOutput(secret, "mcp", registry), "[REDACTED:secret]");
  assert.equal(redactProtocolOutput(secret, "a2a", registry), "[REDACTED:secret]");
  const probe = dispatcherProbe(async () => ({ ordinary: secret }), () => registry.values(), {}, () => registry.forms());
  for (let i = 0; i < 3; i++) assert.equal((await probe.run()).isError, false);
  registry.register(secret, "another-name");
  registry.replaceGroup(Symbol("duplicate"), [secret, secret]);
  assert.equal(registry.forms(), forms);
  assert.equal(derived, 1);
});

test("model-only error clipping cannot split an emoji after redaction", async () => {
  const result = await dispatcherProbe(async () => { throw new Error("ordinary failure"); }, () => []).run();
  assert.ok(result.isError);
  const input = { ...result, error: { ...result.error, message: "word ".repeat(60).slice(0, 298) + "😀 trailing" } };
  const safe = modelToolError(input, [], { home: "/fixture" });
  assert.ok(safe.error.message.isWellFormed());
  assert.ok(safe.error.message.length <= 300);
});

test("grant metadata shares the registry forms across repeated reads", async t => {
  const { defaults } = await import("@plur1bus/config-schema");
  const { createSecretStore } = await import("../../src/secrets/store.ts");
  const { createMemoryBackend } = await import("../../src/secrets/memory-backend.ts");
  const { createMemoryAuditSink } = await import("../../src/secrets/audit.ts");
  const { buildSecretMethods } = await import("../../src/secrets/rpc.ts");
  const store = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend({ available: false }),
    fileFallback: () => false, audit: createMemoryAuditSink() });
  const secret = randomUUID();
  store.redaction.register(secret, "fixture");
  let derived = 0;
  const original = Buffer.from;
  t.mock.method(Buffer, "from", (...args: unknown[]) => {
    if (args[0] === secret) derived++;
    return Reflect.apply(original, Buffer, args) as ReturnType<typeof Buffer.from>;
  });
  store.redaction.forms();
  const methods = buildSecretMethods({ store, config: () => defaults(), principalOf: () => ({ kind: "owner" }) });
  for (let i = 0; i < 3; i++) {
    const result = await methods["secret.grants.list"]({}, { signal: new AbortController().signal } as never);
    assert.deepEqual(result, { agentLeasesEnabled: false, grants: [], references: [] });
  }
  assert.equal(derived, 1);
});
