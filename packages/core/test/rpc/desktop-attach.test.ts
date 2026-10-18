import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { DeviceStore } from "../../../remote-access/src/device-store.ts";
import { DesktopAttach } from "../../src/identity/desktop-attach.ts";

test("desktop codes bind person/kind, expire at ten minutes, are one-use; tokens follow device revocation", () => {
  const dir = mkdtempSync(join(tmpdir(), "desktop-attach-")); let now = 1000; let version: number|null=1;
  const events: unknown[] = [];
  try {
    const audit = { append(e: unknown) { events.push(e); } };
    const devices = new DeviceStore({ file: join(dir,"devices.json"),clock:()=>now,audit,securePath:()=>{} });
    const attach = new DesktopAttach({ file:join(dir,"attach.db"), devices, now:()=>now, audit, personVersion:()=>version, securePath:()=>{} });
    const key = () => generateKeyPairSync("ed25519").publicKey.export({format:"der",type:"spki"}).toString("base64");
    try {
      const grant = attach.issue("alice", "desktop");
      assert.equal(grant.expiresAt, now + 600_000);
      assert.throws(()=>attach.redeem(grant.code, "phone", "PC", key()));
      const paired = attach.redeem(grant.code, "desktop", "PC", key());
      assert.equal(paired.device.pairedBy,"alice"); assert.equal(paired.device.platform,"desktop");
      assert.throws(()=>attach.redeem(grant.code,"desktop","Other",key()));
      assert.equal(attach.authenticate(paired.token).userId,"alice");
      assert.ok(!JSON.stringify(events).includes(grant.code)); assert.ok(!JSON.stringify(events).includes(paired.token));
      assert.ok(!readFileSync(join(dir,"attach.db")).includes(Buffer.from(paired.token)));
      devices.revoke(paired.device.id,"alice");
      assert.throws(()=>attach.authenticate(paired.token));
      assert.throws(()=>attach.resolve(paired.device.id));
      const changed=attach.issue("alice","desktop");version=2;
      assert.throws(()=>attach.redeem(changed.code,"desktop","Changed",key()));
      const active=attach.redeem(attach.issue("alice","desktop").code,"desktop","Active",key());
      version=null;assert.throws(()=>attach.authenticate(active.token));version=3;assert.throws(()=>attach.authenticate(active.token));
      const expired = attach.issue("alice","desktop"); now=expired.expiresAt;
      assert.throws(()=>attach.redeem(expired.code,"desktop","Old",key()));
    } finally { attach.close(); }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("native pairing and private device services refuse agents, scopes, viewer and forwarded identities",async()=>{
  const {createDeviceSurface}=await import("../../src/rpc/device-surface.ts");
  const {guardMethods}=await import("../../src/rbac/guard.ts");
  const {bindApiPrincipal}=await import("../../../module-api/src/api-principal.ts");
  const dir=mkdtempSync(join(tmpdir(),"desktop-guard-")),stop=new AbortController();
  try {
    const audit={append(){}},raw=createDeviceSurface({state:dir,clock:Date.now,audit,securePath:()=>{},signal:stop.signal});
    let principal:any={userId:"alice",kind:"person",role:"member"};
    const methods=guardMethods(raw,{resolve:()=>principal,now:Date.now,audit});
    const ctx={signal:stop.signal,requestId:"fixture",connectionId:"fixture"};
    assert.equal((await methods["device.pair"]!({kind:"desktop"},ctx) as any).kind,"desktop");
    for(const denied of [{kind:"person",role:"viewer"},{kind:"agent",role:"owner"},{kind:"person",role:"owner",tokenScopes:[]}]){
      principal={userId:"alice",...denied};await assert.rejects(methods["device.pair"]!({kind:"desktop"},ctx));
    }
    for(const context of [ctx,{...ctx}]){
      if(context!==ctx)bindApiPrincipal(context,{userId:"alice",kind:"person",role:"owner"});
      for(const name of ["admin.api.desktop.redeem","admin.api.desktop.token","admin.api.desktop.resolve"])await assert.rejects(raw[name]!({},context),e=>(e as any).error==="E_DENIED");
    }
  }finally{stop.abort();rmSync(dir,{recursive:true,force:true});}
});
