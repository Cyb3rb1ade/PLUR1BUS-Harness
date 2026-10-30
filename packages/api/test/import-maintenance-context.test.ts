/** A maintenance cookie retains authority only for its fixed run and lifetime. */
import assert from "node:assert/strict";
import test from "node:test";
import { ImportMaintenanceContext } from "../src/import-maintenance.ts";
import { SessionStore } from "../src/session.ts";
import { FakeClock } from "../src/clock.ts";
import type { ImportRun } from "../../rpc-schema/generated/types.ts";

test("offline admission is initiating-cookie and run bound; logout, credential version, expiry and terminal state revoke it", async () => {
  const clock = new FakeClock(),
    sessions = new SessionStore(clock);
  let version = 4;
  const principal = { userId: "alice", kind: "person" as const, role: "admin" as const };
  const run: ImportRun = {
    runId: "12345678-1234-4123-8123-123456789012",
    planId: "12345678-1234-4123-8123-123456789013",
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
    port: {
      status: async () => ({ run }),
      abort: async () => ({ runId: run.runId, accepted: true, state: "rolling-back" }),
    },
  });
  const first = sessions.create({ kind: "user", id: "alice", role: "admin" }, { authVersion: 4 }),
    other = sessions.create({ kind: "user", id: "alice", role: "admin" }, { authVersion: 4 });
  contexts.remember({
    sessionId: first.id,
    session: first.session,
    principal,
    connectionKey: "connection",
    runId: run.runId,
  });
  const body = { jsonrpc: "2.0", id: 1, method: "admin.import.status", params: { runId: run.runId } };
  assert.ok(await contexts.admit(first.id, "web.rpc", body));
  assert.equal(await contexts.admit(other.id, "web.rpc", body), undefined);
  assert.equal(await contexts.admit(first.id, "web.rpc", { ...body, params: { runId: other.id } }), undefined);
  for (const method of ["admin.import.apply", "config.set", "admin.extensions.setup.set", "core.status"])
    assert.equal(await contexts.admit(first.id, "web.rpc", { ...body, method }), undefined);
  assert.ok(await contexts.admit(first.id, "csrf.issue"));
  assert.ok(await contexts.admit(first.id, "whoami"));
  version++;
  assert.equal(await contexts.admit(first.id, "web.rpc", body), undefined);
  version = 4;
  contexts.remember({
    sessionId: first.id,
    session: first.session,
    principal,
    connectionKey: "connection",
    runId: run.runId,
  });
  sessions.destroy(first.id);
  assert.equal(await contexts.admit(first.id, "web.rpc", body), undefined);
  contexts.remember({
    sessionId: other.id,
    session: other.session,
    principal,
    connectionKey: "other",
    runId: run.runId,
  });
  run.state = "completed";
  const final = await contexts.admit(other.id, "web.rpc", body);
  assert.ok(final);
  assert.equal((await contexts.dispatch(final, body)).jsonrpc, "2.0");
  run.state = "applying";
  assert.equal(
    await contexts.admit(other.id, "web.rpc", body),
    undefined,
    "a terminal observation clears the context permanently",
  );
  contexts.close();
});

test("status and reload do not renew the fixed active-run lifetime", async () => {
  const clock = new FakeClock(),
    sessions = new SessionStore(clock),
    principal = { userId: "alice", kind: "person" as const, role: "owner" as const };
  const run: ImportRun = {
    runId: "12345678-1234-4123-8123-123456789012",
    planId: "12345678-1234-4123-8123-123456789013",
    sourceType: "fixture",
    state: "applying",
    attempt: 1,
    createdAt: new Date(clock.now()).toISOString(),
    updatedAt: new Date(clock.now()).toISOString(),
    restored: false,
    resumable: false,
    rollbackAvailable: false,
  };
  const context = new ImportMaintenanceContext({
    sessions,
    now: () => clock.now(),
    ttlMs: 1000,
    credentialVersion: () => 1,
    port: {
      status: async () => ({ run }),
      abort: async () => ({ runId: run.runId, accepted: true, state: "rolling-back" }),
    },
  });
  const who = sessions.create({ kind: "user", id: "alice", role: "owner" }, { authVersion: 1 });
  const input = { sessionId: who.id, session: who.session, principal, connectionKey: "same", runId: run.runId };
  context.remember(input);
  clock.advance(100);
  const first = await context.admit(who.id, "whoami");
  assert.ok(first);
  clock.advance(500);
  context.remember(input);
  assert.equal((await context.admit(who.id, "whoami"))?.expiresAt, first.expiresAt);
  clock.advance(400);
  assert.equal(await context.admit(who.id, "whoami"), undefined);
  context.close();
});
test("device sessions cannot acquire offline authority and fixed maintenance lifetime is not renewed by reads", async () => {
  const clock = new FakeClock(),
    sessions = new SessionStore(clock),
    principal = { userId: "alice", kind: "person" as const, role: "owner" as const };
  let calls = 0;
  const contexts = new ImportMaintenanceContext({
    sessions,
    now: () => clock.now(),
    ttlMs: 1000,
    credentialVersion: () => 1,
    port: {
      status: async () => {
        calls++;
        throw new Error("no active run");
      },
      abort: async () => {
        throw new Error("unreachable");
      },
    },
  });
  const device = sessions.create(
    { kind: "user", id: "alice", role: "owner" },
    {
      authVersion: 1,
      device: { deviceId: "device", userId: "alice", scopes: ["imports.manage"], expiresAt: clock.now() + 10000 },
    },
  );
  contexts.remember({
    sessionId: device.id,
    session: device.session,
    principal,
    connectionKey: "device",
    runId: "12345678-1234-4123-8123-123456789012",
  });
  assert.equal(await contexts.admit(device.id, "whoami"), undefined);
  assert.equal(calls, 0);
  const person = sessions.create({ kind: "user", id: "alice", role: "owner" }, { authVersion: 1 });
  contexts.remember({
    sessionId: person.id,
    session: person.session,
    principal,
    connectionKey: "person",
    runId: "12345678-1234-4123-8123-123456789012",
  });
  clock.advance(1000);
  assert.equal(await contexts.admit(person.id, "whoami"), undefined);
  assert.equal(calls, 0);
  contexts.close();
});

test("an explicit native run-proof refusal retires the cookie context instead of reviving on a later status", async () => {
  const clock = new FakeClock(),
    sessions = new SessionStore(clock);
  const principal = { userId: "alice", kind: "person" as const, role: "owner" as const };
  const run: ImportRun = {
    runId: "12345678-1234-4123-8123-123456789012",
    planId: "12345678-1234-4123-8123-123456789013",
    sourceType: "fixture",
    state: "applying",
    attempt: 1,
    createdAt: new Date(clock.now()).toISOString(),
    updatedAt: new Date(clock.now()).toISOString(),
    restored: false,
    resumable: false,
    rollbackAvailable: false,
  };
  let denied = true;
  const context = new ImportMaintenanceContext({
    sessions,
    now: () => clock.now(),
    credentialVersion: () => 1,
    port: {
      status: async () => {
        if (denied) throw { error: "E_DENIED", reason: "native-proof" };
        return { run };
      },
      abort: async () => ({ runId: run.runId, accepted: true, state: "rolling-back" }),
    },
  });
  const person = sessions.create({ kind: "user", id: "alice", role: "owner" }, { authVersion: 1 });
  context.remember({
    sessionId: person.id,
    session: person.session,
    principal,
    connectionKey: "person",
    runId: run.runId,
  });
  assert.equal(await context.admit(person.id, "whoami"), undefined);
  denied = false;
  assert.equal(
    await context.admit(person.id, "whoami"),
    undefined,
    "only a newly successful live apply can bind again",
  );
  context.close();
});

test("only the typed Core stopping lifecycle is unavailable; explicit authority and generic availability refusals stay closed", async () => {
  const { coreTransportUnavailable } = await import("../src/import-maintenance.ts");
  assert.equal(coreTransportUnavailable({ error: "E_CORE_UNAVAILABLE", reason: "core-stopping" }), true);
  for (const error of [
    { error: "E_NOT_AVAILABLE", message: "core stopping" },
    { error: "E_NOT_AVAILABLE", reason: "core-stopping" },
    { error: "E_DENIED", reason: "core-stopping" },
    { error: "E_DENIED", code: "ENOENT" },
    { error: "E_UNAUTHORIZED", code: "ECONNRESET" },
    { error: "E_UNAUTHORIZED", reason: "core-stopping" },
    { error: "E_CORE_UNAVAILABLE", reason: "core-handshake" },
  ])
    assert.equal(coreTransportUnavailable(error), false);
});
