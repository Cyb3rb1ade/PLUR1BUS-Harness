import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getApi, setApiForTests } from "../src/api/shared.ts";
import { sessionNotice, sessionState } from "../src/session.ts";
import type { Api } from "../src/api/index.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setApiForTests(undefined);
  sessionNotice.value = null;
  sessionState.value = { status: "checking" };
});

test("getApi is one instance; setApiForTests swaps it and undefined restores a real client", () => {
  const a = getApi();
  assert.equal(getApi(), a);
  const fake = {} as Api;
  setApiForTests(fake);
  assert.equal(getApi(), fake);
  setApiForTests(undefined);
  assert.notEqual(getApi(), fake);
});

test("a 401 on a read sends the UI to sign-in without the expired notice", async () => {
  globalThis.fetch = (async () => new Response("{}", { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch;
  sessionState.value = { status: "authenticated", user: { id: "owner", role: "owner" } };
  await assert.rejects(getApi().get("/api/v1/agents"), (e: { kind?: string }) => e.kind === "unauthenticated");
  assert.equal(sessionState.value.status, "anonymous");
  assert.equal(sessionNotice.value, null);
});

test("a 401 while fetching the CSRF token of a write shows the expired notice", async () => {
  globalThis.fetch = (async () => new Response("{}", { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch;
  sessionState.value = { status: "authenticated", user: { id: "owner", role: "owner" } };
  await assert.rejects(getApi().rpc("test.echo", {}), (e: { kind?: string }) => e.kind === "session-expired");
  assert.equal(sessionState.value.status, "anonymous");
  assert.equal(sessionNotice.value, "expired");
});
