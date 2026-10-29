import { it } from "node:test";
import assert from "node:assert/strict";
import { createImportMaintenanceHold } from "../../src/import/maintenance-admission.ts";

const RUN = "9488a983-b15c-4281-9669-d09228686fc5";
const ctx = { requestId: "r", connectionId: "c", signal: new AbortController().signal };

it("holds public user/device/data writes and background routing until the bound job releases", async () => {
  const hold = createImportMaintenanceHold(RUN);
  let started = 0;
  assert.equal(hold.defer(async () => { started++; }), true);
  const methods = hold.methods(Object.fromEntries(["core.status", "user.list", "device.list", "memory.capture",
    "user.role.set", "device.revoke", "secret.set", "memory.recall", "memory.list", "memory.show",
    "session.get", "admin.api.person.resolve", "admin.api.unregistered.resolve", "admin.import.runtime.complete"]
    .map(name => [name, async () => name])));
  for (const read of ["core.status", "user.list", "device.list", "admin.api.person.resolve", "admin.import.runtime.complete"]) {
    assert.equal(await methods[read]!({}, ctx), read);
  }
  for (const write of ["memory.capture", "memory.recall", "memory.list", "memory.show", "session.get",
    "user.role.set", "device.revoke", "secret.set", "admin.api.unregistered.resolve"]) {
    await assert.rejects(methods[write]!({}, ctx), (error: { reason?: string }) => error.reason === "busy");
  }
  assert.equal(started, 0);
  await assert.rejects(hold.release("other"));
  assert.equal(started, 0);
  await hold.release(RUN);
  await hold.release(RUN);
  assert.equal(started, 1);
  assert.equal(await methods["memory.capture"]!({}, ctx), "memory.capture");
});
