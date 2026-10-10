import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { DeviceStore } from "../../../remote-access/src/device-store.ts";
import { buildDeviceSurface } from "../../src/rpc/device-surface.ts";
import { guardMethods } from "../../src/rbac/guard.ts";
import type { Principal } from "../../src/rbac/types.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";

const publicKey = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
test("device RPC filters ownership, enforces stored owner, roles, scopes and human-only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "device-rpc-"));
  try {
    const audit = memoryAuditSink();
    const store = new DeviceStore({ file: join(dir, "devices.json"), clock: () => 1000, audit, securePath: () => {} });
    const own = store.recordPairing({ name: "Phone", platform: "ios", publicKey: publicKey(), pairedBy: "alice", scope: [] });
    const other = store.recordPairing({ name: "PC", platform: "linux", publicKey: publicKey(), pairedBy: "bob", scope: [] });
    let principal: Principal | null = { userId: "alice", role: "member", kind: "person" };
    const methods = guardMethods(buildDeviceSurface(store), { resolve: () => principal, now: () => 1000, audit });
    const call = (m: string, p: any = {}) => methods[m]!(p, { signal: new AbortController().signal, requestId: "1", connectionId: "test" });
    assert.deepEqual(await call("device.list"), { devices: [own] });
    await assert.rejects(call("device.revoke", { id: other.id, pairedBy: "alice" }), /not permitted|not permitted|own device/);
    await call("device.rename", { id: own.id, name: "Tablet" });
    assert.equal(store.list()[0]!.name, "Tablet");
    await call("device.revoke", { id: own.id });
    assert.equal(store.list()[0]!.revoked, true);
    principal = { userId: "alice", role: "admin", kind: "person" };
    assert.equal((await call("device.list") as any).devices.length, 2);
    await call("device.revoke", { id: other.id });
    await assert.rejects(call("device.rename", { id: other.id, name: "Mine" }), /own device/);
    for (const role of ["owner", "admin", "operator", "member", "viewer"] as const) {
      principal = { userId: "alice", role, kind: "agent", tokenScopes: ["device.*"] };
      for (const m of ["device.list", "device.revoke", "device.rename"]) await assert.rejects(call(m, { id: own.id, name: "x" }), /not permitted/);
    }
    principal = { userId: "alice", role: "owner", kind: "person", tokenScopes: [] };
    await assert.rejects(call("device.list"), /not permitted/);
    principal = { userId: "alice", role: "alien" as any, kind: "person" };
    await assert.rejects(call("device.list"), /not permitted/);
    principal = null; await assert.rejects(call("device.list"), /authentication/);
    assert.ok(audit.events.some(e => e.action === "device.renamed"));
    assert.ok(audit.events.some(e => e.action === "device.revoked"));
    // The handler independently fails closed if accidentally mounted without its guard.
    await assert.rejects(buildDeviceSurface(store)["device.list"]!({}, { signal: new AbortController().signal, requestId: "1", connectionId: "raw" }), /authentication/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
