// Shell approval state contains only native public metadata; cancellation cannot resurrect a stale challenge.
import test from "node:test";
import assert from "node:assert/strict";
const connection = { id: "connection-a", origin: "https://harness.example" };
const metadata = { handle: "019a0000-0000-7000-8000-000000000001", userCode: "ABCD-2345", purpose: "extensions",
  verificationUri: "https://harness.example/#/desktop/approve", expiresAt: 1700000300000, state: "pending" };
async function model() {
  const module = await import("../src/models/stepup.ts").catch(() => undefined);
  assert.equal(typeof module?.createStepUp, "function", "shell must offer the real native approval flow");
  return module!.createStepUp(connection, "extensions", () => 1700000000000);
}
test("shell approval sends a stored connection and purpose, never credentials or browser URL input", async () => {
  const state = await model(), calls: unknown[] = [];
  assert.equal(await state.begin(async request => { calls.push(request); return metadata; }), true);
  assert.deepEqual([...calls], [{ connectionId: connection.id, purpose: "extensions" }]);
  assert.equal(state.value?.userCode, "ABCD-2345");
  assert.equal(await state.poll(async request => { calls.push(request); return { ...metadata, state: "approved" }; }), true);
  assert.deepEqual(calls[1], { connectionId: connection.id, handle: metadata.handle });
  assert.equal(state.value?.state, "approved");
  await state.open(async request => { calls.push(request); });
  assert.deepEqual(calls[2], { connectionId: connection.id, handle: metadata.handle });
});
test("shell rejects proof fields, another origin, purpose changes and expired public responses", async () => {
  for (const extra of [{ proofToken: "NATIVE-PRIVATE-MARKER" }, { challengeId: "NATIVE-PRIVATE-MARKER" },
    { verificationUri: "https://other.example/#/desktop/approve" }, { purpose: "imports" }, { expiresAt: 1699999999999 }]) {
    const state = await model();
    assert.equal(await state.begin(async () => ({ ...metadata, ...extra })), false);
    assert.equal(state.value, null);
  }
});
test("cancelling during a pending poll cannot resurrect the former handle", async () => {
  const state = await model(); await state.begin(async () => metadata);
  let complete!: (value: unknown) => void;
  const poll = state.poll(() => new Promise(resolve => { complete = resolve; }));
  const cancelled: unknown[] = [];
  await state.cancel(async request => { cancelled.push(request); });
  complete({ ...metadata, state: "approved" }); await poll;
  assert.equal(state.value, null);
  assert.deepEqual(cancelled, [{ connectionId: connection.id, handle: metadata.handle }]);
});

test("a second-factor refusal offers approval without turning the enrollment into a repair", async () => {
  const { pairingFailure } = await import("../src/models/pairing-model.ts");
  assert.deepEqual(pairingFailure("second-factor-required"), {phase: "error", error: "second-factor-required", retry: "retry"});
});

test("bounded server rate limits preserve retry guidance without changing the enrollment", async () => {
  const { pairingFailure } = await import("../src/models/pairing-model.ts");
  assert.deepEqual(pairingFailure("rate-limited:12"), {phase:"error",error:"rate-limited",retry:"retry"});
  const state = await model(); await state.begin(async()=>metadata);
  assert.equal(await state.poll(async()=>{throw "rate-limited:12";}),false);
  assert.equal(state.retryAfter,12); assert.equal(state.value?.state,"pending");
});
