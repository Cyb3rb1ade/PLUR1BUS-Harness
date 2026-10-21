// Audit secrets #2, #4, #5 (2026-10-20): a description may carry no secret value of the store (agents are given descriptions);
// a failed index write in the keyring leaves the old state; an owner cannot enter a value too short to be masked.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { createFileBackend } from "../../src/secrets/file-backend.ts";
import { createKeyringBackend } from "../../src/secrets/keyring-backend.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { buildSecretMethods } from "../../src/secrets/rpc.ts";
import { createSecretRedaction } from "../../src/secrets/redaction.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { MIN_REDACTED_VALUE_CHARS, SecretError, type SecretBackend, type SecretPrincipal } from "../../src/secrets/types.ts";
import { fakeClock, fakeKeyring, secure } from "./helpers.ts";

const owner: SecretPrincipal = { kind: "owner", id: "tester" };
const core: SecretPrincipal = { kind: "core" };
const K1 = "sk-first-key-0123456789"; const K2 = "sk-second-key-9876543210";
const refused = (e: unknown) => { assert.ok(e instanceof SecretError, String(e)); assert.equal(e.code, "invalid-description"); assert.ok(!e.message.includes(K1) && !e.message.includes(K2)); return true; };

function twoBackends(file: SecretBackend = createMemoryBackend(), keyring: SecretBackend = createMemoryBackend()) {
  const mk = () => createSecretStore({ keyring, file, fileFallback: () => true, audit: createMemoryAuditSink(), clock: fakeClock() });
  return { keyring, file, store: mk(), restarted: mk };
}

describe("a description holds no value of another secret", () => {
  it("refuses another secret's value, without echoing it, and writes nothing", async () => {
    const { store } = twoBackends();
    await store.set(owner, "openai.key", K1);
    await assert.rejects(() => store.set(owner, "anthropic.key", K2, `second key, spare: ${K1}`), refused);
    assert.deepEqual((await store.list(owner)).map((m) => m.name), ["openai.key"]);
    assert.equal((await store.set(owner, "anthropic.key", K2, "second key for the team account")).description, "second key for the team account");
  });

  it("holds after a restart, when the process has not seen the value yet (every stored value is compared)", async () => {
    const { restarted, store } = twoBackends();
    await store.set(owner, "openai.key", K1);
    const fresh = restarted();
    await assert.rejects(() => fresh.set(owner, "anthropic.key", K2, `spare ${K1}`), refused);
  });

  it("covers the file backend and a keyring that is away (the other copy still counts)", async () => {
    const kr = fakeKeyring();
    const keyring = createKeyringBackend({ service: "s", load: async () => kr });
    const file = createFileBackend({ dir: join(tempDir("p1b-deschyg-"), "secrets"), secure });
    const { store } = twoBackends(file, keyring);
    await file.put("from.file", K1, new Date());
    await keyring.put("from.keyring", K2, new Date());
    await assert.rejects(() => store.set(owner, "k", "other-value-12345", `has ${K1}`), refused);
    await assert.rejects(() => store.set(owner, "k", "other-value-12345", `has ${K2}`), refused);
  });

  it("covers a value the owner has deleted (the process still knows it) and an older value of the same name", async () => {
    const { store } = twoBackends();
    await store.set(owner, "a", K1);
    await store.delete(owner, "a");
    await assert.rejects(() => store.set(owner, "b", K2, `old ${K1}`), refused);
    await store.set(owner, "c", K1 + "-v1");
    await store.set(owner, "c", K1 + "-v2");
    await assert.rejects(() => store.set(owner, "c", K1 + "-v3", `was ${K1}-v1`), refused);
  });

  it("does not trip on names, short values or ordinary prose", async () => {
    const { store } = twoBackends();
    await store.set(owner, "openai.key", K1);
    await store.set(owner, "pin", "abc");
    const meta = await store.set(owner, "anthropic.key", K2, "same account as openai.key, not the pin abc");
    assert.equal(meta.description, "same account as openai.key, not the pin abc");
  });

  it("an older description that already carries a registered value is masked where agents read it (status)", async () => {
    const { store, keyring } = twoBackends();
    await store.set(owner, "openai.key", K1);
    await keyring.put("legacy", K2, new Date(), "tester", `written before the check: ${K1}`);
    const row = (await store.status(core)).secrets!.find((s) => s.name === "legacy")!;
    assert.ok(!row.description!.includes(K1));
    assert.equal(row.description, "written before the check: [redacted]");
  });
});

describe("keyring: a failed index write leaves the old state", () => {
  function failingIndex() {
    const kr = fakeKeyring();
    const Base = kr.Entry; let failIndex = false;
    class Entry extends Base { override setPassword(p: string): void { if (failIndex && (this as unknown as { user: string }).user.startsWith("__plur1bus-index")) throw Object.assign(new Error("index write failed"), { code: "EIO" }); super.setPassword(p); } }
    const keyring = createKeyringBackend({ service: "s", load: async () => ({ Entry }) });
    return { kr, keyring, fail: (v: boolean) => { failIndex = v; } };
  }
  const t = new Date("2026-10-20T10:00:00.000Z");

  it("the value is rolled back to the old one and the index agrees", async () => {
    const { keyring, fail } = failingIndex();
    await keyring.put("k", "old-value-12345", t);
    fail(true);
    await assert.rejects(() => keyring.put("k", "new-value-12345", t), (e: unknown) => e instanceof SecretError && e.code === "storage");
    fail(false);
    assert.equal(await keyring.get("k"), "old-value-12345");
    assert.deepEqual((await keyring.list()).map((m) => m.name), ["k"]);
  });

  it("a name that did not exist is removed again", async () => {
    const { keyring, fail } = failingIndex();
    fail(true);
    await assert.rejects(() => keyring.put("fresh", "new-value-12345", t), (e: unknown) => e instanceof SecretError && e.code === "storage");
    fail(false);
    assert.equal(await keyring.get("fresh"), null);
    assert.deepEqual(await keyring.list(), []);
  });

  it("through the store: the failed set reports the error and changes nothing", async () => {
    const { keyring, fail } = failingIndex();
    const file = createFileBackend({ dir: join(tempDir("p1b-roll-"), "secrets"), secure });
    const store = createSecretStore({ keyring, file, fileFallback: () => true, audit: createMemoryAuditSink(), clock: fakeClock() });
    await store.set(owner, "k", "old-value-12345");
    fail(true);
    await assert.rejects(() => store.set(owner, "k", "new-value-12345"), (e: unknown) => e instanceof SecretError && e.code === "storage");
    fail(false);
    assert.equal((await store.reveal(owner, "k")).value, "old-value-12345", "the failed rotation changed nothing");
  });
});

describe("a short value is accepted and comes back with a warning (#652)", () => {
  const rig = () => {
    const store = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit: createMemoryAuditSink(), clock: fakeClock() });
    return { store, methods: buildSecretMethods({ store, principalOf: () => owner }) };
  };
  const ctx = {} as never;
  it(`secret.set stores a value of fewer than ${MIN_REDACTED_VALUE_CHARS} characters and answers with a warning that never contains it`, async () => {
    const { store, methods } = rig();
    for (const v of ["x", "1234567", "pin-77"]) {
      const r = await methods["secret.set"]({ name: "k", value: v }, ctx) as any;
      assert.equal(r.name, "k");
      assert.deepEqual(Object.keys(r.warning).sort(), ["code", "message", "minMaskedChars"]);
      assert.equal(r.warning.code, "short-value-unmasked");
      assert.equal(r.warning.minMaskedChars, MIN_REDACTED_VALUE_CHARS);
      assert.ok(v.length === 1 || !JSON.stringify(r).includes(v), "the value is not echoed");
      assert.equal((await store.reveal(owner, "k")).value, v, "the short value was stored");
    }
  });
  it("a value of exactly the redactor's minimum, and a longer one, come back without a warning", async () => {
    const { methods } = rig();
    for (const v of ["12345678", "a much longer value"]) {
      const r = await methods["secret.set"]({ name: "k", value: v }, ctx) as any;
      assert.equal("warning" in r, false, v);
    }
  });
  it("the store itself (the core's own writes) takes a one-character value and adds nothing to the metadata", async () => {
    const { store } = rig();
    const meta = await store.set(owner, "inprocess", "1");
    assert.equal("warning" in meta, false);
    assert.equal((await store.reveal(owner, "inprocess")).value, "1");
  });
  it("a short value is still not masked by the redactor (the limit the warning describes)", async () => {
    const r = createSecretRedaction();
    r.register("short", "k");
    assert.equal(r.contains("a short word"), false);
    r.register("long enough", "k");
    assert.equal(r.contains("a long enough value"), true);
  });
  it("an agent with a short value is still refused as denied (the gate comes before the value is looked at)", async () => {
    const store = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit: createMemoryAuditSink(), clock: fakeClock() });
    const methods = buildSecretMethods({ store, principalOf: () => ({ kind: "agent" }) });
    await assert.rejects(() => methods["secret.set"]({ name: "k", value: "x" }, ctx), (e: any) => e.error === "E_DENIED");
  });
});
