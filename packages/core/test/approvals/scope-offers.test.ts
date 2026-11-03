/** Every approval caller is limited to the scopes in the persisted request, independently of the capability ceiling. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GrantScope } from "../../src/policy/index.ts";
import { askFor, lastNonce, rig, tick } from "./service-helpers.ts";

const cases: [GrantScope[], GrantScope][] = [
  [["once"], "task"], [["once"], "session"], [["once"], "always"], [[], "once"], [["session"], "once"],
];
for (const [offered, requested] of cases) {
  test(`unoffered scope ${requested} is refused when the request offers ${offered.join(",") || "none"}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "cx-approval-scopes-"));
    const r = await rig({ path: join(directory, "permissions.sqlite") });
    try {
      const ask = askFor();
      ask.request.grantOptions = offered.map(scope => ({ scope, requiredSurface: 3 }));
      const pending = r.service.request(ask);
      await tick();
      const { id, nonce } = lastNonce(r);
      assert.deepEqual(r.service.decide({ requestId: id, nonce, decision: "approve", scope: requested,
        person: "christian", surface: 3 }), { ok: false, reason: "scope-unavailable" });
      assert.equal(r.stores.approvals.get(id)!.status, "pending", "a rejected scope cannot consume the nonce");
      assert.equal(r.stores.grants.inspect({ person: "christian" }).length, 0);
      assert.ok(r.audit.events.some(event => event.action === "approval.refused" && event.detail.reason === "scope-unavailable"));
      if (offered[0]) {
        assert.equal(r.service.decide({ requestId: id, nonce, decision: "approve", scope: offered[0],
          person: "christian", surface: 3 }).ok, true);
        const answer = await pending;
        assert.equal(answer.approved, true);
        assert.equal(answer.scope, offered[0]);
      } else {
        assert.equal(r.service.decide({ requestId: id, nonce, decision: "deny", person: "christian", surface: 1 }).ok, true);
        assert.equal((await pending).approved, false, "denial remains available without an offered grant scope");
      }
    } finally { r.service.dispose(); await tick(); r.stores.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}
