import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveEngineJobAuthority } from "../../src/engine/job-authority.ts";
import { AdminStore } from "../../src/identity/admin-store.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import { createIdentityService } from "../../src/identity/service.ts";
import { alwaysCap, open, DAY } from "../grants/helpers.ts";

test("engine job authority follows a standing grant, live rights and the linked identity", async t => {
  const root = mkdtempSync(join(tmpdir(), "engine-job-grant-"));
  const store = await open(join(root, "grants.sqlite"));
  const people = new AdminStore({ path: ":memory:", ownerId: "operator" });
  const identity = createIdentityService({ dbPath: join(root, "identity.sqlite"), clock: () => store.clock.now(), audit: () => {} });
  t.after(() => { identity.close(); people.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const actor = { user: "operator", host: "fixture", role: "owner", kind: "person" } as const;
  const human = identity.createHuman({ displayName: "Grant owner" }, actor);
  const link = identity.link({ humanId: human.id, identity: { channel: "telegram", accountId: "fixture", userId: "grant-owner" } }, actor);
  people.setRole(human.id, "member", () => {});
  const workspace = realpathSync(import.meta.dirname);
  const resolve = (dryRun: boolean, job = "embedding-drain", agentId = "bernd") =>
    resolveEngineJobAuthority({ agents: { workspaceOf: id => id === "bernd" ? workspace : undefined }, resolvePerson: id => people.resolvePerson(id), identity, grants: store.grants, now: store.clock.now() }, agentId, job, dryRun);
  const grant = (person: string) => alwaysCap({
    capability: "memory.jobs.run", person, createdBy: person, jobId: "engine:embedding-drain", surface: 2,
  });
  assert.throws(() => store.grants.create({ ...grant(human.id), jobId: "engine:embedding-drain", scope: "session", sessionId: "session" }));
  assert.throws(() => store.grants.create({ ...grant(human.id), delegable: true }));
  assert.equal(resolve(true), null);
  const g = store.grants.create(grant(human.id));
  assert.equal(resolve(true), null);
  people.setRight("bernd", human.id, "use");
  assert.equal(resolve(true), null);
  people.setRight("bernd", human.id, "manage");
  assert.equal(resolve(true, "gc-run"), null);
  assert.equal(resolve(true, "embedding-drain", "other"), null);
  assert.deepEqual(resolve(true), {
    agentId: "bernd", workspace: `workspace-dir:v1:${workspace}`, trust: "proved",
    user: deriveUserPrincipal(human.id), channel: "telegram", accountId: "fixture",
    chat: { id: "", kind: "direct" },
  });
  assert.equal(store.grants.get(g.id)?.lastUsedAt, undefined);
  assert.equal(resolve(false)?.user, deriveUserPrincipal(human.id));
  assert.equal(store.grants.get(g.id)?.lastUsedAt, store.clock.now());
  const second = identity.createHuman({ displayName: "Second owner" }, actor);
  identity.link({ humanId: second.id, identity: { channel: "telegram", accountId: "fixture", userId: "second" } }, actor);
  people.setRole(second.id, "member", () => {});
  people.setRight("bernd", second.id, "manage");
  const secondGrant = store.grants.create(grant(second.id));
  assert.equal(resolve(true), null);
  store.grants.revoke(secondGrant.id, second.id);
  assert.equal(resolve(true)?.user, deriveUserPrincipal(human.id));
  people.setDisabled(human.id, true, actor.user, store.clock.now(), () => {});
  assert.equal(resolve(true), null);
  people.setDisabled(human.id, false, actor.user, store.clock.now(), () => {});
  identity.unlink({ linkId: link.id }, actor);
  assert.equal(resolve(true), null);
  identity.link({ humanId: human.id, identity: { channel: "telegram", accountId: "fixture", userId: "grant-owner" } }, actor);
  store.clock.advance(91 * DAY);
  assert.equal(resolve(true), null);
});
