// Optional per-secret description (<= 200 characters, never a value): kept by every backend, validated by the store,
// returned by list/get/status, and backward compatible with entries and files written before the field existed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { FILE_SCHEMA, createFileBackend } from "../../src/secrets/file-backend.ts";
import { createKeyringBackend } from "../../src/secrets/keyring-backend.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { MAX_DESCRIPTION_CHARS, SecretError, type SecretBackend } from "../../src/secrets/types.ts";
import { MARKER, fakeKeyring, secure } from "./helpers.ts";

const owner = { kind: "owner" as const, id: "tester" };
const t1 = new Date("2026-10-06T10:00:00.000Z"); const t2 = new Date("2026-10-06T11:00:00.000Z");
const invalid = (e: unknown) => { assert.ok(e instanceof SecretError, String(e)); assert.equal(e.code, "invalid-description"); assert.ok(!e.message.includes(MARKER)); return true; };

const backends: [string, () => SecretBackend][] = [
  ["memory", () => createMemoryBackend()],
  ["file", () => createFileBackend({ dir: join(tempDir("p1b-secd-"), "secrets"), secure })],
  ["keyring (fake module)", () => { const k = fakeKeyring(); return createKeyringBackend({ service: "plur1bus:test", load: async () => k }); }],
];

for (const [label, make] of backends) {
  describe(`secret description: ${label} backend`, () => {
    it("stores a description, keeps it when a rotation names none, replaces it, and clears it with an empty one", async () => {
      const b = make();
      const first = await b.put("api.key", MARKER, t1, "tester", "Billing key for the OpenAI account");
      assert.equal(first.description, "Billing key for the OpenAI account");
      assert.equal((await b.list())[0]!.description, "Billing key for the OpenAI account");
      const rotated = await b.put("api.key", `${MARKER}2`, t2, "tester");
      assert.equal(rotated.description, "Billing key for the OpenAI account");
      assert.equal((await b.list())[0]!.description, "Billing key for the OpenAI account");
      await b.put("api.key", `${MARKER}3`, t2, "tester", "Replaced text");
      assert.equal((await b.list())[0]!.description, "Replaced text");
      const cleared = await b.put("api.key", `${MARKER}4`, t2, "tester", "");
      assert.equal("description" in cleared, false);
      assert.equal("description" in (await b.list())[0]!, false);
      assert.equal(await b.get("api.key"), `${MARKER}4`);
    });
    it("an entry without a description lists exactly as before (no key at all)", async () => {
      const b = make();
      await b.put("plain", MARKER, t1, "tester");
      assert.deepEqual(Object.keys((await b.list())[0]!).sort(), ["backend", "createdAt", "name", "updatedAt", "updatedBy"]);
    });
  });
}

describe("secret description: file format", () => {
  it("keeps the schema id, leaves no description key on old-style entries, and reads a file written before the field existed", async () => {
    const dir = join(tempDir("p1b-secd-"), "secrets");
    const b = createFileBackend({ dir, secure });
    await b.put("old", MARKER, t1, "tester");
    const raw = readFileSync(join(dir, "store.json"), "utf8");
    assert.equal(JSON.parse(raw).schema, FILE_SCHEMA);
    assert.equal(FILE_SCHEMA, "plur1bus.secrets-file/1"); // the id is bound into every entry's AAD: it must not change
    assert.ok(!raw.includes("description"));
    await b.put("new", MARKER, t1, "tester", "has one");
    assert.equal(JSON.parse(readFileSync(join(dir, "store.json"), "utf8")).entries.new.description, "has one");
    // The first entry is still the pre-field shape; a fresh backend reads both and decrypts both.
    const again = createFileBackend({ dir, secure });
    assert.deepEqual((await again.list()).map(m => [m.name, m.description]), [["new", "has one"], ["old", undefined]]);
    assert.equal(await again.get("old"), MARKER);
  });
  it("a description in the file is not part of the ciphertext binding: editing it does not break decryption, a non-string one is corrupt", async () => {
    const dir = join(tempDir("p1b-secd-"), "secrets");
    const b = createFileBackend({ dir, secure });
    await b.put("k", MARKER, t1, "tester", "before");
    const p = join(dir, "store.json"); const doc = JSON.parse(readFileSync(p, "utf8"));
    doc.entries.k.description = 7; writeFileSync(p, JSON.stringify(doc));
    await assert.rejects(() => createFileBackend({ dir, secure }).list(), (e: unknown) => e instanceof SecretError && e.code === "corrupt");
  });
});

describe("secret description: store", () => {
  const rig = () => createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend({ available: false }), fileFallback: () => false, audit: createMemoryAuditSink() });

  it("set returns it; list, meta and status carry it; a rotation without one keeps it; an empty one clears it", async () => {
    const store = rig();
    const m = await store.set(owner, "openai.key", MARKER, "  Billing key, rotate every quarter  ");
    assert.equal(m.description, "Billing key, rotate every quarter");
    assert.equal((await store.list(owner))[0]!.description, "Billing key, rotate every quarter");
    assert.equal((await store.meta(owner, "openai.key")).description, "Billing key, rotate every quarter");
    assert.equal((await store.status(owner)).secrets![0]!.description, "Billing key, rotate every quarter");
    await store.set(owner, "openai.key", `${MARKER}2`);
    assert.equal((await store.meta(owner, "openai.key")).description, "Billing key, rotate every quarter");
    await store.set(owner, "openai.key", `${MARKER}3`, "   ");
    assert.equal("description" in (await store.meta(owner, "openai.key")), false);
    assert.equal("description" in (await store.status(owner)).secrets![0]!, false);
  });
  it("accepts exactly 200 characters (code points), refuses 201", async () => {
    const store = rig();
    await store.set(owner, "ok", MARKER, "x".repeat(MAX_DESCRIPTION_CHARS));
    await store.set(owner, "emoji", MARKER, "𝄞".repeat(MAX_DESCRIPTION_CHARS));
    await assert.rejects(() => store.set(owner, "long", MARKER, "x".repeat(MAX_DESCRIPTION_CHARS + 1)), invalid);
    await assert.rejects(() => store.set(owner, "long", MARKER, "𝄞".repeat(MAX_DESCRIPTION_CHARS + 1)), invalid);
    assert.equal((await store.list(owner)).some(m => m.name === "long"), false);
  });
  it("refuses control characters, a non-string, and the secret's own value, without echoing it and without writing anything", async () => {
    const store = rig();
    await assert.rejects(() => store.set(owner, "k", MARKER, "line one\nline two"), invalid);
    await assert.rejects(() => store.set(owner, "k", MARKER, "tab\there"), invalid);
    await assert.rejects(() => store.set(owner, "k", MARKER, "nul\u0000"), invalid);
    await assert.rejects(() => store.set(owner, "k", MARKER, 5 as unknown as string), invalid);
    await assert.rejects(() => store.set(owner, "k", MARKER, `pasted by mistake: ${MARKER}`), invalid);
    assert.deepEqual(await store.list(owner), []);
  });
  it("a short value does not make every description that contains the letter invalid", async () => {
    const store = rig();
    await store.set(owner, "k", "abc", "A cabinet key");
    assert.equal((await store.meta(owner, "k")).description, "A cabinet key");
  });
  it("the audit line for a set never carries the description", async () => {
    const audit = createMemoryAuditSink();
    const store = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend({ available: false }), fileFallback: () => false, audit });
    await store.set(owner, "k", MARKER, "Distinctive description text");
    assert.ok(audit.events.length > 0);
    assert.ok(!JSON.stringify(audit.events).includes("Distinctive description text"));
  });
});
