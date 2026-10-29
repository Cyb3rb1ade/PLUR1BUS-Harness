/** Approval browser receives public metadata only and delegates writes to the existing CSRF session client. */
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "../src/router.ts";

test("the fixed native approval page is an authenticated hidden route", () => {
  const route = resolve("/desktop/approve");
  assert.equal(route.kind, "page");
  if (route.kind === "page") { assert.equal(route.item.id, "desktop"); assert.equal(route.sub, "approve"); }
});

test("approval client accepts a human code and returns only closed public metadata", async () => {
  const module = await import("../src/pages/desktop-approval-model.ts").catch(() => undefined);
  assert.equal(typeof module?.DesktopApprovalClient, "function", "approval browser needs its public-only client");
  const now = 1700000000000, calls: Array<{ url: string; init?: RequestInit }> = [];
  const details = { schema: "desktop.step-up.approval/1", userCode: "ABCD-2345", deviceId: "actual-device", purpose: "imports", state: "pending", expiresAt: now + 300000 };
  const writes: unknown[] = [];
  const client = new module!.DesktopApprovalClient({ now: () => now,
    fetch: async (url: string, init?: RequestInit) => { calls.push({ url, ...init ? { init } : {} }); return new Response(JSON.stringify(details)); },
    write: async (method: string, path: string, body: unknown) => {
      writes.push({ method, path, body });
      return { ok: true, status: 200, body: { ...details, schema: "desktop.step-up.decision/1", state: "approved" } };
    } });
  assert.equal((await client.lookup("abcd 2345")).deviceId, "actual-device");
  assert.deepEqual(calls, [{ url: "/api/v1/desktop/step-up/approval/ABCD-2345", init: { credentials: "same-origin", headers: { accept: "application/json" } } }]);
  assert.equal((await client.decide("ABCD-2345", "approve")).state, "approved");
  assert.deepEqual(writes, [{ method: "POST", path: "/api/v1/desktop/step-up/decision", body: { userCode: "ABCD-2345", decision: "approve" } }]);
  assert.equal(JSON.stringify(calls).includes("authorization"), false);
  for (const key of ["proofToken", "challengeId", "token"]) {
    const invalid = new module!.DesktopApprovalClient({ now: () => now,
      fetch: async () => new Response(JSON.stringify({ ...details, [key]: "PRIVATE-MUST-NOT-ENTER-BROWSER-STATE" })),
      write: async () => { throw new Error("unused"); } });
    await assert.rejects(invalid.lookup("ABCD-2345"), error => (error as Error).message === "unavailable");
  }
});

test("approval validation rejects hostile input, another code, and expired details before any decision", async () => {
  const module = await import("../src/pages/desktop-approval-model.ts").catch(() => undefined);
  assert.equal(typeof module?.DesktopApprovalClient, "function");
  let calls = 0;
  const client = new module!.DesktopApprovalClient({ now: () => 1000,
    fetch: async () => { calls++; return new Response(JSON.stringify({ schema: "desktop.step-up.approval/1", userCode: "ABCD-2345", deviceId: "device", purpose: "imports", state: "pending", expiresAt: 999 })); },
    write: async () => { throw new Error("unused"); } });
  for (const input of ["../../session", "a".repeat(200), "ABCD\u00002345", "https://example.test"]) await assert.rejects(client.lookup(input));
  assert.equal(calls, 0);
  await assert.rejects(client.lookup("ABCD-2345"), error => (error as Error).message === "expired");
});
