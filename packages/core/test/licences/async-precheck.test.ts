/** Configuration writes must wait for asynchronous media validation. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { LicenceLedger } from "../../src/licences/ledger.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { guardMethods } from "../../src/rbac/guard.ts";
import { buildLicenceSurface } from "../../src/rpc/licence-surface.ts";

it("awaits a rejected media check before allowing the config write", async () => {
  const ledger = new LicenceLedger(":memory:", memoryAuditSink(), () => 1);
  try {
    const failure = Promise.resolve().then(() => { throw new Error("media-not-supported"); });
    void failure.catch(() => {});
    const methods = guardMethods(buildLicenceSurface(ledger, () => ({}), () => failure), {
      resolve: () => ({ kind: "person", role: "owner", userId: "owner" }), now: () => 1,
      audit: memoryAuditSink(),
    });
    let writes = 0;
    await assert.rejects(async () => {
      await methods["model.licence.check"]!({ changes: [] }, {
        requestId: "test", connectionId: "test", signal: new AbortController().signal,
      });
      writes++;
    }, /media-not-supported/);
    assert.equal(writes, 0);
  } finally {
    ledger.close();
  }
});
