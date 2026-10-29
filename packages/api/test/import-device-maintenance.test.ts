/** Only an API-private imports-purpose MFA provenance can bind a native cookie to its live-authorized run. */
import assert from "node:assert/strict";
import test from "node:test";
import { FakeClock } from "../src/clock.ts";
import { DesktopStepUp, type DesktopPurpose } from "../src/desktop-stepup.ts";
import { ImportMaintenanceContext } from "../src/import-maintenance.ts";
import { MemoryUserDirectory } from "../src/memory-stores.ts";
import { SessionStore } from "../src/session.ts";
import type { CoreRpc } from "../src/core-rpc.ts";
import type { ImportRun } from "../../rpc-schema/generated/types.ts";

async function fixture(t: import("node:test").TestContext, purpose: DesktopPurpose = "imports") {
  const clock = new FakeClock(),
    sessions = new SessionStore(clock),
    users = new MemoryUserDirectory();
  users.add({ id: "alice", username: "alice", role: "owner" });
  let version = 1;
  const identity = {
    deviceId: "native-fixture",
    userId: "alice",
    scopes: ["chat:read", "imports.read", "imports.manage", "extensions.read", "extensions.manage"],
    expiresAt: clock.now() + 86400_000,
  };
  const person = { userId: "alice", kind: "person" as const, role: "owner" as const, disabled: false, version: 3 };
  const core = {
    serviceCall: async (method: string) => {
      if (method === "admin.api.person.resolve") return { person };
      if (method === "admin.api.desktop.token" || method === "admin.api.desktop.resolve") return identity;
      throw { error: "E_DENIED" };
    },
  } as unknown as CoreRpc;
  const authority = new DesktopStepUp({ core, clock, sessions, users, credentialVersion: () => version });
  const token = "a".repeat(43),
    challenge = await authority.start(token, purpose);
  const browser = sessions.create(
    { kind: "user", id: "alice", role: "owner" },
    { authVersion: 1, stepUpAt: clock.now() },
  );
  await authority.decision(browser.session, challenge.userCode, "approve");
  const poll = await authority.poll(token, challenge.challengeId);
  if (!("proofToken" in poll)) throw new Error("approval fixture failed");
  const proof = await authority.verify(token, poll.proofToken, "session");
  const device = sessions.create(
    { kind: "user", id: "alice", role: "owner" },
    {
      authVersion: person.version,
      stepUpAt: proof.stepUpAt,
      device: { ...identity, scopes: proof.grantedScopes },
    },
  );
  authority.bindSession(device.session, proof);
  const principal = { ...person, tokenScopes: [...proof.grantedScopes] };
  const run: ImportRun = {
    runId: "12345678-1234-4123-8123-123456789011",
    planId: "12345678-1234-4123-8123-123456789012",
    sourceType: "fixture",
    state: "applying",
    attempt: 1,
    createdAt: new Date(clock.now()).toISOString(),
    updatedAt: new Date(clock.now()).toISOString(),
    restored: false,
    resumable: false,
    rollbackAvailable: false,
  };
  const contexts = new ImportMaintenanceContext({
    sessions,
    now: () => clock.now(),
    credentialVersion: () => version,
    importSessionProof: (session, who) => authority.importSessionProof(session, who),
    port: {
      status: async () => ({ run }),
      abort: async () => ({ runId: run.runId, accepted: true, state: "rolling-back" }),
    },
  });
  t.after(() => {
    contexts.close();
    authority.close();
  });
  const remember = () =>
    contexts.remember({
      sessionId: device.id,
      session: device.session,
      principal,
      connectionKey: "native-cookie",
      runId: run.runId,
    });
  const body = { jsonrpc: "2.0", id: 1, method: "admin.import.status", params: { runId: run.runId } };
  return {
    clock,
    sessions,
    contexts,
    authority,
    principal,
    device,
    browser,
    remember,
    body,
    run,
    revoke: () => {
      version++;
    },
  };
}

test("verified imports-purpose native cookie can retain only its own admitted run and survives the approval grant deadline", async (t) => {
  const f = await fixture(t);
  f.remember();
  assert.ok(await f.contexts.admit(f.device.id, "web.rpc", f.body));
  assert.equal(await f.contexts.admit(f.device.id, "web.rpc", { ...f.body, method: "config.set" }), undefined);
  assert.equal(
    await f.contexts.admit(f.device.id, "web.rpc", { ...f.body, params: { runId: f.run.planId } }),
    undefined,
  );
  f.clock.advance(300_001);
  f.sessions.destroy(f.browser.id);
  assert.ok(
    await f.contexts.admit(f.device.id, "web.rpc", f.body),
    "redeemed native cookie follows its own normal session lifetime",
  );
  f.revoke();
  assert.equal(
    await f.contexts.admit(f.device.id, "web.rpc", f.body),
    undefined,
    "API-local credential version invalidates offline proof",
  );
});
test("publicly copied MFA fields and another cookie cannot forge the private provenance", async (t) => {
  const f = await fixture(t);
  const copy = f.sessions.create(
    { ...f.device.session.principal },
    {
      authVersion: f.device.session.authVersion,
      stepUpAt: f.device.session.stepUpAt!,
      device: structuredClone(f.device.session.device!),
    },
  );
  f.contexts.remember({
    sessionId: copy.id,
    session: copy.session,
    principal: f.principal,
    connectionKey: "copy",
    runId: f.run.runId,
  });
  assert.equal(await f.contexts.admit(copy.id, "web.rpc", f.body), undefined);
  f.remember();
  f.device.session.device!.scopes.push("settings.write");
  assert.equal(
    await f.contexts.admit(f.device.id, "web.rpc", f.body),
    undefined,
    "device grant mutation invalidates the retained run binding",
  );
});
for (const purpose of ["session", "extensions"] as const)
  test(`${purpose}-purpose native approval cannot confer offline import authority`, async (t) => {
    const f = await fixture(t, purpose);
    f.remember();
    assert.equal(await f.contexts.admit(f.device.id, "web.rpc", f.body), undefined);
  });
