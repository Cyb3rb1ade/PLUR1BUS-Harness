/** Migration is missing-only, and rollback deletes only a name this run proved absent and created itself. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createSecretStore } from "../../src/secrets/store.ts";
import { createKeyringBackend } from "../../src/secrets/keyring-backend.ts";
import { createFileBackend } from "../../src/secrets/file-backend.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { fakeKeyring, secure } from "../secrets/helpers.ts";
import { openMaintenanceJournal } from "../../src/import/maintenance-journal.ts";
import { createImportSourceSecrets } from "../../src/import/source-secrets.ts";
import { useTempDirs } from "./helpers.ts";

const temp = useTempDirs();
const RUN = "d45955e0-e7ef-4628-9687-cc9b67b6f321";
const MARKER = "fixture-migrated-provider-secret-never-serialized";
const binding = { ownerId: "owner", planId: "8b98eef7-128b-401f-86fb-243d7fd702bb", planSha256: "a".repeat(64),
  preflightId: "82a25157-2577-4f8c-97f1-057d82ca12f4" };

async function fixture() {
  const module = await import("../../src/import/secret-migration.ts").catch(() => undefined);
  assert.equal(typeof module?.migrateImportSecrets, "function", "opt-in import must reach the actual SecretStore");
  const home = temp();
  const journal = openMaintenanceJournal(home, RUN);
  journal.advance("snapshotting");
  journal.advance("snapshot-complete", { snapshotSha256: "a".repeat(64) });
  journal.advance("applying");
  const keyring = createKeyringBackend({ service: "plur1bus:import-fixture", load: async () => fakeKeyring() });
  const audit = createMemoryAuditSink();
  const store = createSecretStore({ keyring, file: createFileBackend({ dir: join(home, "secrets"), secure }),
    fileFallback: () => false, audit });
  const source = createImportSourceSecrets();
  source.prepare({ ...binding, expiresAt: Date.now() + 60_000,
    entries: new Map([["OPENAI_API_KEY", Buffer.from(MARKER)]]) });
  return { api: module!, store, audit, journal, source, lease: source.take(binding) };
}

describe("allowlisted import secret migration", () => {
  it("stores a missing allowlisted value with durable intent and emits key metadata only", async () => {
    const { api, store, journal, source, lease, audit } = await fixture();
    try {
      const result = await api.migrateImportSecrets({ runId: RUN, store, journal, lease });
      assert.deepEqual(result, { imported: ["OPENAI_API_KEY"], skipped: [] });
      assert.equal((await store.reveal({ kind: "owner" }, "OPENAI_API_KEY")).value, MARKER);
      assert.equal((await store.meta({ kind: "owner" }, "OPENAI_API_KEY")).updatedBy, `import:${RUN}`);
      assert.deepEqual(journal.read().secrets,
        [{ name: "OPENAI_API_KEY", absentBefore: true, created: true, removed: false }]);
      assert.ok(!JSON.stringify({ result, journal: journal.read(), audit: audit.events }).includes(MARKER));
      assert.deepEqual([...lease.entries()], []);
    } finally { source.close(); }
  });

  it("skips existing targets and preserves them when the run rolls back", async () => {
    const { api, store, journal, source, lease } = await fixture();
    try {
      await store.set({ kind: "owner", id: "original-owner" }, "OPENAI_API_KEY", "pre-existing-key");
      assert.deepEqual(await api.migrateImportSecrets({ runId: RUN, store, journal, lease }),
        { imported: [], skipped: ["OPENAI_API_KEY"] });
      journal.advance("rolling-back", { reason: "aborted" });
      await api.rollbackImportSecrets({ runId: RUN, store, journal });
      assert.equal((await store.reveal({ kind: "owner" }, "OPENAI_API_KEY")).value, "pre-existing-key");
      assert.deepEqual(journal.read().secrets, []);
    } finally { source.close(); }
  });

  it("recovers the crash window after backend set but before the created receipt and never deletes a later rotation", async () => {
    const { api, store, journal, source, lease } = await fixture();
    try {
      lease.release();
      journal.secretIntent("OPENAI_API_KEY");
      await store.set({ kind: "owner", id: `import:${RUN}` }, "OPENAI_API_KEY", MARKER);
      journal.advance("rolling-back", { reason: "recovered" });
      await api.rollbackImportSecrets({ runId: RUN, store, journal });
      assert.equal((await store.status({ kind: "core" })).secrets?.length, 0);
      assert.equal(journal.read().secrets[0]?.removed, true);
      journal.advance("restored", { reason: "recovered" });
      journal.resume();
      journal.advance("snapshotting");
      journal.advance("snapshot-complete", { snapshotSha256: "a".repeat(64) });
      journal.advance("applying");
      source.prepare({ ...binding, expiresAt: Date.now() + 60_000,
        entries: new Map([["OPENAI_API_KEY", Buffer.from(MARKER)]]) });
      await api.migrateImportSecrets({ runId: RUN, store, journal, lease: source.take(binding) });
      await store.set({ kind: "owner", id: "later-owner" }, "OPENAI_API_KEY", "later rotation");
      journal.advance("rolling-back", { reason: "manual-rollback" });
      await assert.rejects(api.rollbackImportSecrets({ runId: RUN, store, journal }));
      assert.equal((await store.reveal({ kind: "owner" }, "OPENAI_API_KEY")).value, "later rotation");
    } finally { source.close(); }
  });
});
