import { test } from "node:test";
import assert from "node:assert/strict";
import { deliverBreakglassNotice } from "../../src/rpc/breakglass-notices.ts";
test("only affected-person subscribers receive live notices; mixed audience and agents withhold delivery", async () => {
  const notice={kind:"granted",userId:"affected",grantId:"grant",holderUserId:"owner",reason:"Investigate incident",expiresAt:2000} as const;
  const sent:unknown[]=[]; let audience=[{connectionId:"affected",names:["breakglass.notice"]}]; let agent=false;
  const deps={subscriptions:()=>audience,principalOf:async(id:string)=>({userId:id,role:"member" as const,kind:agent?"agent" as const:"person" as const}),notify:(_m:string,p:object)=>{sent.push(p);},stopped:()=>false};
  assert.equal(await deliverBreakglassNotice(notice,deps),true); assert.equal(sent.length,1);
  audience.push({connectionId:"unrelated",names:["breakglass.notice"]});
  assert.equal(await deliverBreakglassNotice(notice,deps),false); assert.equal(sent.length,1);
  audience=audience.slice(0,1);agent=true;assert.equal(await deliverBreakglassNotice(notice,deps),false);
});
