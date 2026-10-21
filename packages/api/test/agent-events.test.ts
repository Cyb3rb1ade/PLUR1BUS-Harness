import test from "node:test";
import assert from "node:assert/strict";
import type { ApiPrincipal, AudienceTarget } from "@plur1bus/module-api";
import { AGENT_WEB_EVENTS, webEventAllowed } from "../src/events-route.ts";

test("every web agent event needs a typed agent audience and current RBAC, never a self/connection substitute", () => {
  const base: ApiPrincipal = { userId: "viewer", role: "viewer", kind: "person" };
  const delivery = (audience: readonly AudienceTarget[] | null) => ({ audience, connectionId: "connection" });
  for (const method of AGENT_WEB_EVENTS) {
    for (const audience of [null, [], ["bernd"], ["connection"], [{ personId: "viewer" }], [{ connectionId: "connection" }], [{ agentId: "bernd" }]] as (readonly AudienceTarget[] | null)[]) {
      assert.equal(webEventAllowed(method, base, delivery(audience)), false, `${method} ${JSON.stringify(audience)}`);
    }
    for (const role of ["member", "viewer"] as const) {
      assert.equal(webEventAllowed(method, { ...base, role, agentRights: { bernd: "use" } }, delivery([{ agentId: "bernd" }])), true, method);
      assert.equal(webEventAllowed(method, { ...base, role, agentRights: { anna: "manage" } }, delivery([{ agentId: "bernd" }])), false, method);
    }
    for (const role of ["owner", "admin"] as const) assert.equal(webEventAllowed(method, { ...base, role }, delivery([{ agentId: "bernd" }])), true, method);
    assert.equal(webEventAllowed(method, { ...base, role: "owner", tokenScopes: ["agent.list"] }, delivery([{ agentId: "bernd" }])), false, method);
    assert.equal(webEventAllowed(method, { ...base, agentRights: { bernd: "use" }, tokenScopes: ["agent.read"] }, delivery([{ agentId: "bernd" }])), true, method);
    assert.equal(webEventAllowed(method, base, delivery([{ agentId: "bernd", personId: "viewer" } as unknown as AudienceTarget])), false, method);
  }
});


test("value-free model-options invalidation may be global; session data still requires its audience",()=>{
 const principal:ApiPrincipal={userId:"viewer",role:"viewer",kind:"person"};
 assert.equal(webEventAllowed("chat.models.changed",principal,{audience:null,connectionId:"c"}),true);
 assert.equal(webEventAllowed("session.event",principal,{audience:null,connectionId:"c"}),false);
});
