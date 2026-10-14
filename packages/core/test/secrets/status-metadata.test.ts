import { it } from "node:test";
import assert from "node:assert/strict";
import { createSecretStore } from "../../src/secrets/store.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";

it("status exposes persisted metadata without reading values and rotation preserves creation", async () => {
  let clock = 1000;
  const backend = createMemoryBackend();
  const store = createSecretStore({ keyring: backend, file: createMemoryBackend({ available: false }), fileFallback: () => false, clock: () => clock, audit: { record() {} } });
  const person = { kind: "owner" as const, id: "person-alice" };
  await store.set(person, "example", "fixture value");
  clock = 2000;
  await store.set(person, "example", "replacement value");
  backend.get = async () => { throw new Error("status must not read a value"); };
  const status = await store.status(person);
  assert.deepEqual(status.secrets, [{ name: "example", backend: "memory", createdAt: new Date(1000).toISOString(), updatedAt: new Date(2000).toISOString(), updatedBy: "person-alice" }]);
  assert.equal(JSON.stringify(status).includes("replacement value"), false);
});

it("keyring and file metadata retain the writer across backend reopening", async () => {
  const { createKeyringBackend } = await import("../../src/secrets/keyring-backend.ts");
  const { createFileBackend } = await import("../../src/secrets/file-backend.ts");
  const { fakeKeyring, secure } = await import("./helpers.ts");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "p1b-secret-metadata-"));
  try {
    const keyring = fakeKeyring();
    const factories = [() => createKeyringBackend({ service: "metadata-test", load: async () => keyring }), () => createFileBackend({ dir, secure })];
    for (const factory of factories) {
      await factory().put("example", "fixture value", new Date(1000), "person-alice");
      const reopened = factory();
      assert.deepEqual((await reopened.list())[0], { name: "example", backend: reopened.kind, createdAt: new Date(1000).toISOString(), updatedAt: new Date(1000).toISOString(), updatedBy: "person-alice" });
      await reopened.put("example", "rotated value", new Date(2000), "person-bob");
      assert.equal((await factory().list())[0]?.updatedBy, "person-bob");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("unknown legacy timestamps are omitted from status metadata", async () => {
  const backend = createMemoryBackend();
  backend.list = async () => [{ name: "legacy", backend: "memory", createdAt: "", updatedAt: "" }];
  const store = createSecretStore({ keyring: backend, file: createMemoryBackend({ available: false }), fileFallback: () => false, audit: { record() {} } });
  assert.deepEqual((await store.status({ kind: "owner" })).secrets, [{ name: "legacy", backend: "memory" }]);
});

it("status projects only known metadata fields from a backend", async () => {
  const backend = createMemoryBackend();
  backend.list = async () => [{ name: "example", backend: "memory", createdAt: "", updatedAt: "", updatedBy: "person-alice", value: "unexpected fixture data" }];
  const store = createSecretStore({ keyring: backend, file: createMemoryBackend({ available: false }), fileFallback: () => false, audit: { record() {} } });
  assert.deepEqual((await store.status({ kind: "owner" })).secrets, [{ name: "example", backend: "memory", updatedBy: "person-alice" }]);
});
