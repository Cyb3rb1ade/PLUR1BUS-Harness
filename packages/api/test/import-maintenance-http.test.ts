/** Real HTTP outage handling preserves only one authenticated import transaction. */
import assert from "node:assert/strict";
import test from "node:test";
import { AccountStore } from "../src/account-store.ts";
import { createApiServer } from "../src/server.ts";
import { hashPassword } from "../src/password.ts";
import { FakeClock } from "../src/clock.ts";
import type { ImportProgress, ImportRun } from "../../rpc-schema/generated/types.ts";

// Real HTTP, credential database, sessions, CSRF and RPC routing; the typed native run port is a controlled fixture.
// Actual supervisor worker + stopped Core integration is separately required when the parent mounts the native run broker.
test("an active import keeps only initiating-cookie progress and cancellation available during a Core authorization outage", async (t) => {
  const clock = new FakeClock();
  let explicitDenied = false;
  let nativeChecks = 0;
  let live = true,
    role: "owner" | "member" = "owner",
    coreVersion = 1;
  const accounts = new AccountStore({
    path: ":memory:",
    now: () => clock.now(),
    resolve: async (userId) => {
      if (explicitDenied) throw Object.assign(new Error("live refusal"), { error: "E_DENIED", reason: "role-denied" });
      if (!live) throw Object.assign(new Error("Core unavailable"), { code: "ECONNREFUSED" });
      return { userId, kind: "person", role, disabled: false, version: coreVersion };
    },
  });
  accounts.initializeBootstrap("fixture-hash");
  await accounts.bootstrapOwner("fixture-owner", await hashPassword("fixture-password-only"));
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
    progress: { runId: "12345678-1234-4123-8123-123456789012", phase: "apply", completed: 2, total: 10 },
  };
  const calls: string[] = [];
  let push: ((progress: ImportProgress) => void) | undefined;
  const api = createApiServer({
    ownerToken: "a".repeat(64),
    accounts,
    users: accounts,
    clock,
    core: {
      call: async () => {
        throw new Error("local owner credential must not be used");
      },
      callAs: async (method, _params, principal) => {
        calls.push(method);
        assert.equal(principal.userId, "local-owner");
        if (!live) throw new Error("Core unavailable");
        if (method === "admin.import.apply") {
          live = false;
          return { runId: run.runId, state: "queued" } as never;
        }
        throw new Error("unexpected Core call");
      },
    },
    importMaintenance: {
      status: async (identity) => {
        nativeChecks++;
        assert.equal(identity.runId, run.runId);
        assert.equal(identity.principal.userId, "local-owner");
        return { run };
      },
      abort: async (identity) => {
        assert.equal(identity.runId, run.runId);
        run.state = "rolling-back";
        return { runId: run.runId, accepted: true, state: run.state };
      },
      subscribe: async (identity, progress) => {
        assert.equal(identity.runId, run.runId);
        push = progress;
        return () => {
          push = undefined;
        };
      },
    },
  });
  const { url } = await api.listen();
  t.after(async () => {
    await api.close();
    accounts.close();
  });
  accounts.onChange = (id) => {
    api.rightsChanged(id);
  };
  const req = async (path: string, method = "GET", cookie?: string, body?: unknown, csrf?: string) => {
    const response = await fetch(url + path, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      body: (await response.json()) as any,
      cookie: response.headers.get("set-cookie")?.split(";", 1)[0],
    };
  };
  const login = async () => {
    const result = await req("/api/v1/session", "POST", undefined, {
      username: "fixture-owner",
      password: "fixture-password-only",
    });
    assert.equal(result.status, 200);
    return result.cookie!;
  };
  const cookie = await login(),
    other = await login();
  const csrf = async (who: string) => {
    const result = await req("/api/v1/csrf", "GET", who);
    assert.equal(result.status, 200);
    return result.body.token as string;
  };
  let id = 0;
  const rpc = async (method: string, params: object, who = cookie) =>
    req("/rpc", "POST", who, { jsonrpc: "2.0", id: ++id, method, params }, await csrf(who));
  const apply = await rpc("admin.import.apply", {
    planId: run.planId,
    preflightId: "12345678-1234-4123-8123-123456789014",
  });
  assert.equal(apply.body.result.runId, run.runId);
  const status = await rpc("admin.import.status", { runId: run.runId });
  assert.equal(status.body.result.run.progress.completed, 2);
  assert.equal((await req("/api/v1/whoami", "GET", cookie)).status, 200);
  assert.equal(
    (await req("/api/v1/whoami", "GET", other)).status,
    503,
    "a second cookie of the same person is not an offline credential",
  );
  const history = await rpc("admin.import.runs", {});
  assert.deepEqual(
    history.body.result.runs.map((value: ImportRun) => value.runId),
    [run.runId],
  );
  const streamAbort = new AbortController();
  const stream = await fetch(url + "/events", { headers: { cookie }, signal: streamAbort.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type")!, /^text\/event-stream/);
  const reader = stream.body!.getReader();
  let wire = "";
  push?.({ runId: run.runId, phase: "apply", completed: 3, total: 10 });
  push?.({ runId: "12345678-1234-4123-8123-123456789099", phase: "apply", completed: 999, total: 999 });
  while (!wire.includes('"completed":3')) {
    const value = await reader.read();
    if (value.done) break;
    wire += new TextDecoder().decode(value.value);
  }
  assert.ok(wire.includes("event: import.progress"));
  assert.ok(!wire.includes('"completed":999'));
  for (const method of ["config.set", "admin.import.apply", "admin.extensions.setup.set"]) {
    const result = await rpc(method, {});
    assert.equal(result.status, 503, method);
  }
  const abort = await rpc("admin.import.abort", { runId: run.runId });
  assert.equal(abort.body.result.accepted, true);
  assert.equal(run.state, "rolling-back");
  assert.deepEqual(calls, ["admin.import.apply"], "offline infrastructure cannot forward unrelated RPC operations");
  live = true;
  role = "member";
  coreVersion++;
  assert.notEqual(
    (await req("/api/v1/whoami", "GET", cookie)).status,
    200,
    "live Core authority immediately supersedes maintenance admission",
  );
  streamAbort.abort();
  await reader.cancel().catch(() => {});
  live = true;
  role = "owner";
  coreVersion++;
  const fresh = await login();
  await rpc("admin.import.apply", { planId: run.planId, preflightId: "12345678-1234-4123-8123-123456789014" }, fresh);
  const logout = await req("/api/v1/session", "DELETE", fresh, undefined, await csrf(fresh));
  assert.equal(logout.status, 200);
  assert.equal(
    (await req("/api/v1/whoami", "GET", fresh)).status,
    401,
    "logout revokes the run-bound cookie even while Core remains unavailable",
  );
  live = true; role = "owner"; coreVersion++;
  const finalCookie = await login();
  await rpc("admin.import.apply", { planId: run.planId, preflightId: "12345678-1234-4123-8123-123456789014" }, finalCookie);
  const finalCsrf = await csrf(finalCookie), checksBeforeRefusal = nativeChecks;
  explicitDenied = true;
  const denied = await req("/rpc", "POST", finalCookie, { jsonrpc: "2.0", id: ++id, method: "admin.import.status", params: { runId: run.runId } }, finalCsrf);
  assert.equal(denied.status, 403, "an explicit live Core refusal cannot fall back to an active native run");
  assert.equal(nativeChecks, checksBeforeRefusal, "native fallback is not consulted for a live Core refusal");

});
