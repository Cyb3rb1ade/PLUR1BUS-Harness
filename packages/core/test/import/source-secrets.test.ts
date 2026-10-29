/** Source credentials may cross maintenance only in a private, bounded, owner/plan/ticket-bound memory lease. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";

const PLAN = "df311b6e-c160-4bfe-b933-6ab913fbaf4c";
const PREFLIGHT = "8d810b7f-0d8c-4a68-9d22-439ed16b39ed";
const MARKER = "fixture-source-secret-never-in-rpc-event-plan-or-disk";
const binding = { ownerId: "owner", planId: PLAN, planSha256: "a".repeat(64), preflightId: PREFLIGHT };

async function factory() {
  const module = await import("../../src/import/source-secrets.ts").catch(() => undefined);
  assert.equal(typeof module?.createImportSourceSecrets, "function", "pre-stop credentials need private memory leases");
  return module!;
}

describe("private import source secret leases", () => {
  it("allows a single matching owner/plan/ticket take and zeroes values on release without enumerable plaintext", async () => {
    const api = await factory();
    const store = api.createImportSourceSecrets();
    try {
      const original = Buffer.from(MARKER);
      const prepared = store.prepare({ ...binding, expiresAt: Date.now() + 60_000,
        entries: new Map([["OPENAI_API_KEY", original]]) });
      assert.deepEqual(prepared, { prepared: true, count: 1 });
      assert.equal(original.every(value => value === 0), true, "preparation transfers ownership of source buffers");
      assert.throws(() => store.take({ ...binding, ownerId: "another-owner" }));
      const lease = store.take(binding);
      assert.equal(JSON.stringify(lease), "{}");
      assert.ok(!inspect(lease).includes(MARKER));
      assert.deepEqual(Object.keys(lease), []);
      const values = [...lease.entries()];
      assert.equal(values[0]![0], "OPENAI_API_KEY");
      assert.equal(values[0]![1].toString(), MARKER);
      assert.throws(() => store.take(binding));
      lease.release();
      lease.release();
      assert.equal(values[0]![1].every(value => value === 0), true);
      assert.deepEqual([...lease.entries()], []);
    } finally {
      store.close();
    }
  });

  it("rejects unallowlisted names, oversize values and mismatched plan hashes without consuming another lease", async () => {
    const api = await factory();
    const store = api.createImportSourceSecrets();
    try {
      assert.throws(() => store.prepare({ ...binding, expiresAt: Date.now() + 60_000,
        entries: new Map([["MCP_CUSTOM_TOKEN", Buffer.from(MARKER)]]) }));
      assert.throws(() => store.prepare({ ...binding, expiresAt: Date.now() + 60_000,
        entries: new Map([["OPENAI_API_KEY", Buffer.alloc(65_537)]]) }));
      store.prepare({ ...binding, expiresAt: Date.now() + 60_000,
        entries: new Map([["JINA_API_KEY", Buffer.from(MARKER)]]) });
      assert.throws(() => store.take({ ...binding, planSha256: "b".repeat(64) }));
      const lease = store.take(binding);
      assert.equal([...lease.entries()][0]![0], "JINA_API_KEY");
      lease.release();
    } finally {
      store.close();
    }
  });

  it("revokes both prepared and transferred values on expiration and Core shutdown", async () => {
    const api = await factory();
    let now = Date.now();
    const store = api.createImportSourceSecrets({ now: () => now });
    store.prepare({ ...binding, expiresAt: now + 1000,
      entries: new Map([["OPENAI_API_KEY", Buffer.from(MARKER)]]) });
    const lease = store.take(binding);
    const value = [...lease.entries()][0]![1];
    now += 1001;
    assert.deepEqual([...lease.entries()], []);
    assert.equal(value.every(byte => byte === 0), true);
    store.prepare({ ...binding, expiresAt: now + 1000,
      entries: new Map([["OPENAI_API_KEY", Buffer.from(MARKER)]]) });
    const second = store.take(binding);
    const secondValue = [...second.entries()][0]![1];
    store.close();
    assert.equal(secondValue.every(byte => byte === 0), true);
    assert.throws(() => store.take(binding));
  });

  it("rejects values the target SecretStore cannot accept before publishing a pre-stop lease", async () => {
    const api = await factory();
    for (const value of [Buffer.alloc(0), Buffer.from("source\u0000value")]) {
      const store = api.createImportSourceSecrets();
      try {
        assert.throws(() => store.prepare({ ...binding, expiresAt: Date.now() + 1000,
          entries: new Map([["OPENAI_API_KEY", value]]) }));
        assert.equal(value.every(byte => byte === 0), true);
      } finally { store.close(); }
    }
  });
});
