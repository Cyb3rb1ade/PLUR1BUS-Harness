import { AccountStore } from "../src/account-store.ts";
import { bootstrapHash } from "../src/bootstrap.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { buildDesktopAttachHandlers } from "../src/desktop-attach-routes.ts";
import { buildAccountHandlers } from "../src/account-routes.ts";
import { SessionStore } from "../src/session.ts";
import { FakeClock } from "../src/clock.ts";
import type { HandlerDeps, HandlerInput } from "../src/routes.ts";

function rig(required=false) {
 const clock=new FakeClock(),sessions=new SessionStore(clock),origin="http://127.0.0.1:8123";
 const deps={clock,sessions,tls:false,requireSecondFactor:()=>required,core:{serviceCall:async(method:string)=>method==="admin.api.person.resolve"?{person:{userId:"alice",role:"member",kind:"person",disabled:false,version:1}}:{deviceId:"device",userId:"alice",scopes:["chat:read"],expiresAt:clock.now()+86400000}}} as unknown as HandlerDeps;
 const methods=buildDesktopAttachHandlers(deps,o=>o===origin);
 const call=async(name:string,body:object,source=origin)=>methods[name]!({body,origin:source} as HandlerInput);
 const ticket=async()=> (await call("desktop.redeem",{token:"x".repeat(43),origin})).body as any;
 return {clock,sessions,origin,deps,call,ticket};
}
test("desktop tickets bind origin/device, expire after 30 seconds and cannot survive concurrent spends",async()=>{
 const r=rig();
 let ticket=await r.ticket();
 await assert.rejects(r.call("desktop.ticket",{ticket:ticket.ticket,deviceId:"other"}));
 await assert.rejects(r.call("desktop.ticket",{ticket:ticket.ticket,deviceId:"device"}));
 ticket=await r.ticket();await assert.rejects(r.call("desktop.ticket",{ticket:ticket.ticket,deviceId:"device"},"http://localhost:8123"));
 ticket=await r.ticket();r.clock.advance(30000);await assert.rejects(r.call("desktop.ticket",{ticket:ticket.ticket,deviceId:"device"}));
 ticket=await r.ticket();const body={ticket:ticket.ticket,deviceId:"device"};
 const results=await Promise.allSettled([r.call("desktop.ticket",body),r.call("desktop.ticket",body)]);
 assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(r.sessions.countFor("alice"),1);
});
test("native credentials never bypass the configured second-factor policy",async()=>{
 const r=rig(true);await assert.rejects(r.ticket(),e=>(e as any).reason==="second-factor-required");assert.equal(r.sessions.size,0);
 const enrolled=rig(false);Object.assign(enrolled.deps,{totp:{isEnabled:async()=>true}});
 await assert.rejects(enrolled.ticket(),e=>(e as any).reason==="second-factor-required");
 const passkey=rig(false);Object.assign(passkey.deps,{hasPasskeys:()=>true});
 await assert.rejects(passkey.ticket(),e=>(e as any).reason==="second-factor-required");
});
test("remote listeners cannot bootstrap an Owner even if a proof would otherwise be valid",async()=>{
 const r=rig(),proof="p".repeat(43);
 const accounts=new AccountStore({path:":memory:",resolve:async userId=>({userId,kind:"person",role:"owner",disabled:false,version:1})});
 accounts.initializeBootstrap(bootstrapHash(proof));
 try {
   const handlers=buildAccountHandlers(r.deps,accounts,r.deps.core,undefined,false);
   await assert.rejects(async()=>handlers["account.bootstrap"]!({body:{proof,username:"firstperson",password:"long-fixture-password"}} as HandlerInput),e=>(e as any).status===404);
   assert.equal(accounts.hasOwnerAccount(),false);assert.equal(accounts.bootstrapState()?.consumed,false);
 } finally {accounts.close();}
});
test("KNOWN GAP: native ticket redemption completes the existing TOTP/WebAuthn challenge while preserving device/origin/scopes",{todo:"Owner decision: bind native attach to the existing MFA continuation; mandatory MFA currently refuses attach without issuing a session"},async()=>{
 const r=rig(true);assert.equal((await r.ticket()).schema,"session.challenge/1");
});
