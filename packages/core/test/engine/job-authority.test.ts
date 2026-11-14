import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { engineJobGrantStatus, resolveEngineJobAuthority, resolveEngineJobAuthorities } from "../../src/engine/job-authority.ts";
import { AdminStore } from "../../src/identity/admin-store.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import { createIdentityService } from "../../src/identity/service.ts";
import { openPermissionStores } from "../../src/grants/open.ts";
import { staticKeySource } from "../../src/approvals/keys.ts";
import { alwaysCap, DAY, FakeClock, KEY } from "../grants/helpers.ts";

test("engine job authority follows a standing grant, live rights and the linked identity", async t => {
  const root = mkdtempSync(join(tmpdir(), "engine-job-grant-"));
  const clock = new FakeClock();
  const store = await openPermissionStores({
    path: join(root, "grants.sqlite"), keys: staticKeySource(KEY), clock, audit: { record() {} },
  });
  const people = new AdminStore({ path: ":memory:", ownerId: "operator" });
  const identity = createIdentityService({ dbPath: join(root, "identity.sqlite"), clock: () => clock.now(), audit: () => {} });
  t.after(() => { identity.close(); people.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const actor = { user: "operator", host: "fixture", role: "owner", kind: "person" } as const;
  const human = identity.createHuman({ displayName: "Grant owner" }, actor);
  const link = identity.link({ humanId: human.id, identity: { channel: "telegram", accountId: "fixture", userId: "grant-owner" } }, actor);
  people.setRole(human.id, "member", () => {});
  const workspace = realpathSync(import.meta.dirname);
  const deps = () => ({ agents: { workspaceOf: (id: string) => id === "bernd" ? workspace : undefined },
    ownerOf: () => human.id, resolvePerson: (id: string) => people.resolvePerson(id), identity, grants: store.grants, now: clock.now() });
  const resolve = (dryRun: boolean, job = "embedding-drain", agentId = "bernd") =>
    resolveEngineJobAuthority(deps(), agentId, job, dryRun);
  const grant = (person: string) => alwaysCap({
    capability: "memory.jobs.run", person, createdBy: person, jobId: "engine:embedding-drain", surface: 2,
  });
  assert.throws(() => store.grants.create({ ...grant(human.id), jobId: "engine:embedding-drain", scope: "session", sessionId: "session" }));
  assert.throws(() => store.grants.create({ ...grant(human.id), delegable: true }));
  assert.equal(resolve(true), null);
  const g = store.grants.create(grant(human.id));
  assert.equal(resolve(true), null);
  people.setRight("bernd", human.id, "use");
  assert.equal(resolve(true)?.user, deriveUserPrincipal(human.id));
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
  assert.equal(store.grants.get(g.id)?.lastUsedAt, undefined);
  const second = identity.createHuman({ displayName: "Second owner" }, actor);
  identity.link({ humanId: second.id, identity: { channel: "telegram", accountId: "fixture", userId: "second" } }, actor);
  people.setRole(second.id, "member", () => {});
  people.setRight("bernd", second.id, "manage");
  const secondGrant = store.grants.create(grant(second.id));
  assert.equal(resolve(true), null);
  assert.deepEqual(resolveEngineJobAuthorities(deps(), "bernd", "embedding-drain").map(p => p.user),
    [deriveUserPrincipal(human.id), deriveUserPrincipal(second.id)]);
  const wildcard = store.grants.create({ ...grant(human.id), jobId: "engine:*" });
  assert.deepEqual(resolveEngineJobAuthorities(deps(), "bernd", "light-dream").map(p => p.user), [deriveUserPrincipal(human.id)]);
  assert.ok(store.grants.revoke(g.id, human.id));
  assert.equal(resolveEngineJobAuthorities(deps(), "bernd", "embedding-drain").length, 2);
  store.grants.revoke(secondGrant.id, second.id);
  assert.equal(resolve(true)?.user, deriveUserPrincipal(human.id));
  store.grants.create({ ...grant(second.id), jobId: "engine:light-dream" });
  const status = (owner: string | undefined, person: string) =>
    engineJobGrantStatus(store.grants, person, "bernd", clock.now(), owner).state;
  assert.equal(status(human.id, second.id), "never-issued");
  assert.equal(status(undefined, human.id), "never-issued");
  assert.equal(status(human.id, human.id), "active");
  const automatic = store.grants.issueOwnerJobs(human.id, "bernd", "rust-core-start");
  assert.ok(automatic);
  assert.equal(status(second.id, human.id), "active"); // The separate manual wildcard still covers own care.
  store.grants.revoke(wildcard.id, human.id);
  assert.equal(status(second.id, human.id), "revoked"); // The former owner's automatic grant is ineligible.
  const ownCare = store.grants.create(grant(human.id));
  assert.equal(status(second.id, human.id), "active");
  assert.ok(store.grants.revoke(ownCare.id, human.id));
  const continued = store.grants.create({ ...grant(human.id), jobId: "engine:*" });
  people.setDisabled(human.id, true, actor.user, clock.now(), () => {});
  assert.equal(resolve(true), null);
  people.setDisabled(human.id, false, actor.user, clock.now(), () => {});
  identity.unlink({ linkId: link.id }, actor);
  assert.deepEqual(resolve(true), {
    agentId: "bernd", workspace: `workspace-dir:v1:${workspace}`, trust: "proved", user: deriveUserPrincipal(human.id),
    channel: "cli", accountId: "local", chat: { id: "", kind: "direct" },
  });
  assert.equal(store.grants.get(continued.id)?.lastJobTurnAt, undefined);
  identity.link({ humanId: human.id, identity: { channel: "telegram", accountId: "fixture", userId: "grant-owner" } }, actor);
  clock.advance(91 * DAY);
  assert.equal(resolve(true), null);
});
