import assert from "node:assert/strict";
import test from "node:test";
import { requestCore } from "../src/request-core.ts";
import type { ApiPrincipal, ApiTransport } from "@plur1bus/module-api";

test("parallel API request locality stays isolated and never accompanies supervisor delegation", async () => {
  const seen: { user: string; transport?: ApiTransport; endpoint: string }[] = [];
  const wrapped = requestCore({ call: async () => { throw new Error("ordinary local credential must not be used"); },
    async callAs<T>(_method: string, _params: object, principal: ApiPrincipal, endpoint: "core" | "supervisor", _key?: string, transport?: ApiTransport) { await Promise.resolve(); seen.push({ user: principal.userId, ...(transport ? { transport } : {}), endpoint }); return {} as T; },
  });
  await Promise.all((["loopback", "remote"] as const).map(transport => wrapped.run({ userId: transport, kind: "person", role: "admin" }, async () => {
    await Promise.resolve(); await wrapped.core.call("inbox.count");
    await wrapped.core.callAs!("ext.list", {}, { userId: transport, kind: "person", role: "admin" }, "supervisor");
  }, "session", transport)));
  assert.deepEqual(seen.filter(value => value.endpoint === "core").map(value => [value.user, value.transport]).sort(), [["loopback", "loopback"], ["remote", "remote"]]);
  assert.ok(seen.filter(value => value.endpoint === "supervisor").every(value => value.transport === undefined));
});
