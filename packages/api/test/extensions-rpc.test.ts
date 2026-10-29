import assert from "node:assert/strict";
import test from "node:test";
import { rpcRoute, WEB_SUPERVISOR_METHODS } from "../src/rpc-route.ts";
import type { CoreRpc } from "../src/core-rpc.ts";
import { webEventAllowed, WEB_EVENT_NAMES } from "../src/events-route.ts";

const extMethods = [
  "ext.list",
  "ext.show",
  "ext.inspect",
  "ext.inspection.get",
  "ext.install",
  "ext.uninstall",
  "ext.restore",
  "ext.enable",
  "ext.disable",
  "ext.watch",
];
test("extension web exposure is explicit and all five human roles are gated before delegation", async () => {
  for (const method of extMethods) assert.equal(WEB_SUPERVISOR_METHODS.has(method), true, method);
  for (const kind of ["person", "agent"] as const)
    for (const role of ["owner", "admin", "operator", "member", "viewer"] as const) {
      let calls = 0;
      const core: CoreRpc = {
        call: async () => {
          throw new Error("legacy path");
        },
        callAs: async () => {
          calls++;
          return {} as never;
        },
      };
      const r = await rpcRoute(
        core,
        { jsonrpc: "2.0", id: 1, method: "ext.list", params: {} },
        { userId: "a", kind, role },
      );
      const allowed = kind === "person" && ["owner", "admin"].includes(role);
      assert.equal("result" in r, allowed, `${kind}:${role}`);
      assert.equal(calls, allowed ? 1 : 0);
    }
});
test("browser path sources never reach the supervisor, including a spoofed upload plus path", async () => {
  let calls = 0;
  const core: CoreRpc = {
    call: async () => null as never,
    callAs: async () => {
      calls++;
      return {} as never;
    },
  };
  for (const source of [{ path: "/private" }, { path: "/private", upload: "a".repeat(43) }]) {
    const r = await rpcRoute(
      core,
      { jsonrpc: "2.0", id: 1, method: "ext.inspect", params: { source } },
      { userId: "a", kind: "person", role: "owner" },
    );
    assert.equal((r.error as { data: { error: string } }).data.error, "E_DENIED");
  }
  assert.equal(calls, 0);
});
test("extension change events are human Owner/Admin only and audience-bound", () => {
  assert.equal(WEB_EVENT_NAMES.has("ext.changed"), true);
  for (const role of ["owner", "admin", "operator", "member", "viewer"] as const) {
    const p = { userId: "a", kind: "person" as const, role };
    assert.equal(
      webEventAllowed("ext.changed", p, { connectionId: "c", audience: [{ personId: "a" }] }),
      ["owner", "admin"].includes(role),
    );
    assert.equal(webEventAllowed("ext.changed", p, { connectionId: "c", audience: null }), false);
    assert.equal(webEventAllowed("ext.changed", p, { connectionId: "c", audience: [{ personId: "b" }] }), false);
  }
});
