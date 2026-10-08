import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RPC_RULES } from "../../src/rbac/guard.ts";
import { guardMethods } from "../../src/rbac/guard.ts";
import type { Handler, CallContext } from "../../src/rpc/server.ts";
const schema = JSON.parse(
  readFileSync(
    new URL("../../../rpc-schema/schema/rpc.schema.json", import.meta.url),
    "utf8",
  ),
);
export const methods = [
  "media.preferences.get",
  "media.preferences.set",
  "media.generate",
  "media.edit",
  "media.job.get",
  "media.job.list",
  "media.job.cancel",
  "media.output.get",
  "media.output.list",
  "media.output.delete",
  "media.adapters.list",
  "project.create",
  "project.get",
  "project.list",
  "project.update",
  "project.archive",
  "project.member.add",
  "project.member.remove",
  "project.member.role",
  "project.agent.add",
  "project.agent.remove",
  "collab.trace.get",
  "collab.trace.list",
  "collab.chain.cancel",
  "identity.link.request",
  "identity.link.list",
  "identity.link.approve",
  "identity.link.decline",
  "identity.link.remove",
  "identity.principals",
];
const ctx: CallContext = {
  requestId: "r",
  connectionId: "c",
  signal: new AbortController().signal,
};
for (const method of methods) {
  test(`${method}: declared, closed params, RBAC gate`, () => {
    const def = schema.$defs.methods[method];
    assert.ok(def, method);
    assert.equal(def.params.additionalProperties, false);
    assert.ok(RPC_RULES[method], method);
  });
  test(`${method}: unauthenticated never executes`, async () => {
    let ran = false;
    const handlers = guardMethods(
      {
        [method]: (async () => {
          ran = true;
        }) as Handler,
      },
      { resolve: () => null, now: () => 0 },
    );
    await assert.rejects(() => handlers[method]!({}, ctx), {
      error: "E_UNAUTHORIZED",
    });
    assert.equal(ran, false);
  });
}

for (const method of methods) {
  test(`${method}: agent principal never reaches the human surface`, async () => {
    let ran = false;
    const handlers = guardMethods(
      {
        [method]: async () => {
          ran = true;
        },
      },
      {
        resolve: () => ({ userId: "agent", role: "owner", kind: "agent" }),
        now: () => 0,
      },
    );
    await assert.rejects(() => handlers[method]!({}, ctx), {
      error: "E_DENIED",
      reason: "agent-principal",
    });
    assert.equal(ran, false);
  });
  if (
    RPC_RULES[method]?.action.endsWith("write") ||
    method === "project.create"
  )
    test(`${method}: viewer cannot write`, async () => {
      let ran = false;
      const handlers = guardMethods(
        {
          [method]: async () => {
            ran = true;
          },
        },
        {
          resolve: () => ({ userId: "viewer", role: "viewer", kind: "person" }),
          now: () => 0,
        },
      );
      await assert.rejects(() => handlers[method]!({}, ctx), {
        error: "E_DENIED",
      });
      assert.equal(ran, false);
    });
}

test("legacy identity mutations also reject agents without changing users.manage token scope", async () => {
  for (const method of [
    "identity.human.create",
    "identity.link",
    "identity.unlink",
    "identity.pair.start",
    "identity.pair.claim",
    "identity.pair.confirm",
  ]) {
    const handlers = guardMethods(
      { [method]: async () => assert.fail("agent reached identity handler") },
      {
        resolve: () => ({
          userId: "agent",
          role: "owner",
          kind: "agent",
          tokenScopes: ["users.manage"],
        }),
        now: () => 0,
      },
    );
    await assert.rejects(() => handlers[method]!({}, ctx), {
      error: "E_DENIED",
      reason: "agent-principal",
    });
  }
});
