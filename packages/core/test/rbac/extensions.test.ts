/** Extension setup and sign-in authority belongs to authenticated humans, narrowed by token scopes. */
import assert from "node:assert/strict";
import test from "node:test";
import { authorize } from "../../src/rbac/authorize.ts";
import { RPC_RULES } from "../../src/rbac/guard.ts";
import type { Role } from "../../src/rbac/types.ts";

const roles: Role[] = ["owner", "admin", "operator", "member", "viewer"];
test("extensions read and manage belong only to human Owner/Admin, including scoped devices", () => {
  for (const action of ["extensions.read", "extensions.manage"]) for (const role of roles) {
    const p = { userId: role, role, kind: "person" as const };
    assert.equal(authorize(p, action, { kind: "system" }).effect, ["owner", "admin"].includes(role) ? "allow" : "deny", `${role}:${action}`);
    assert.equal(authorize({ ...p, kind: "agent", tokenScopes: [action] }, action, { kind: "system" }).effect, "deny", `agent:${role}:${action}`);
    assert.equal(authorize({ ...p, tokenScopes: [] }, action, { kind: "system" }).effect, "deny", `unscoped:${role}:${action}`);
  }
});
test("every public extension RPC has an explicit human-only extension rule", () => {
  const reads = ["ext.list", "ext.show", "ext.watch", "ext.inspection.get", "admin.extensions.setup.get", "admin.extensions.runtime.status", "admin.extensions.auth.status"];
  const writes = ["ext.inspect", "ext.install", "ext.uninstall", "ext.restore", "ext.enable", "ext.disable", "admin.extensions.setup.set", "admin.extensions.auth.start", "admin.extensions.auth.submit", "admin.extensions.auth.cancel"];
  for (const [methods, action] of [[reads, "extensions.read"], [writes, "extensions.manage"]] as const) for (const method of methods) {
    assert.equal(RPC_RULES[method]?.action, action, method);
    assert.equal(RPC_RULES[method]?.humanOnly, true, method);
  }
});
