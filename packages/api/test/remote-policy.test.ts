import {request} from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createApiServer } from "../src/server.ts";
import { remoteListenerPolicy } from "../src/remote-policy.ts";
import { MemoryUserDirectory,MemoryTotpStore } from "../src/memory-stores.ts";
import { hashPassword } from "../src/password.ts";
import { systemClock } from "../src/clock.ts";
import { SessionStore } from "../src/session.ts";
import { fakeCore } from "./helpers.ts";
import { generateSecret,totpCodeAt } from "../src/totp.ts";

test("remote network cannot bind without TLS/current notice; tailnet never binds all interfaces",()=>{
 const remote={publish:"network" as const,publicOrigin:"https://localhost:18443"};
 assert.throws(()=>remoteListenerPolicy("0.0.0.0",false,remote),/TLS/);
 assert.throws(()=>remoteListenerPolicy("0.0.0.0",true,remote),/confirmed/);
 assert.throws(()=>remoteListenerPolicy("0.0.0.0",true,{...remote,publish:"tailnet"}),/loopback/);
 assert.throws(()=>remoteListenerPolicy("0.0.0.0",true,{...remote,noticeAck:{by:"owner",at:1,version:1},allowSubnets:["invalid"]}),/allowlist/);
 assert.throws(()=>remoteListenerPolicy("127.0.0.1",false,{publish:"tailnet",publicOrigin:"http://localhost"}),/HTTPS/);
 assert.throws(()=>createApiServer({core:fakeCore(),ownerToken:randomBytes(32).toString("hex"),host:"0.0.0.0"}),/loopback/);
});
test("real remote HTTP backend requires Owner/Admin MFA, including imported local cookies; Member remains usable",async t=>{
 const users=new MemoryUserDirectory(),password="fixture-pass-not-a-real-secret",hash=await hashPassword(password);
 for(const role of ["owner","admin","member"] as const)users.add({id:role,username:role,role,passwordHash:hash});
 const sessions=new SessionStore(systemClock),totp=new MemoryTotpStore();
 const api=createApiServer({core:fakeCore(),users,totp,sharedSessions:sessions,ownerToken:randomBytes(32).toString("hex"),remote:{publish:"tailnet",publicOrigin:"https://fixture.local"}});
 const {url}=await api.listen();t.after(()=>api.close());
 const base=url.replace("https:","http:");
 const fetchWire=(url:string,init:RequestInit={}):Promise<Response>=>new Promise((resolve,reject)=>{const headers:Record<string,string>={};new Headers(init.headers).forEach((v,k)=>headers[k]=v);const body=typeof init.body==="string"?init.body:undefined;if(body)headers["content-length"]=String(Buffer.byteLength(body));const req=request(url,{method:init.method??"GET",headers},res=>{const chunks:Buffer[]=[];res.on("data",c=>chunks.push(c));res.on("end",()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode!,headers:Object.fromEntries(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join(", "):v??""]))})));});req.on("error",reject);req.end(body);});
 const login=async(username:string)=>fetchWire(base+"/api/v1/session",{method:"POST",headers:{host:"fixture.local","content-type":"application/json"},body:JSON.stringify({username,password})});
 for(const role of ["owner","admin"]){const r=await login(role);assert.equal(r.status,403);assert.equal((await r.json() as any).reason,"second-factor-required");assert.equal(r.headers.get("set-cookie"),null);}
 const member=await login("member");assert.equal(member.status,200);assert.match(member.headers.get("set-cookie")!,/Secure/);await member.text();
 const local=sessions.create({kind:"user",id:"owner",role:"owner"},{authVersion:1});
 const blocked=await fetchWire(base+"/api/v1/whoami",{headers:{host:"fixture.local",cookie:`__Host-plur1bus_session=${local.id}`}});assert.equal(blocked.status,403);await blocked.text();
 const secret=generateSecret();await totp.put({userId:"owner",secret,enabled:true,createdAt:Date.now(),lastStep:-1,backupHashes:[]});
 const challenge=await login("owner");assert.equal(challenge.status,200);assert.equal(challenge.headers.get("set-cookie"),null);const body=await challenge.json() as any;assert.equal(body.mfa,"totp");
 const proof=await fetchWire(base+"/api/v1/session/totp",{method:"POST",headers:{host:"fixture.local","content-type":"application/json"},body:JSON.stringify({challenge:body.challenge,code:totpCodeAt(secret,Date.now())})});assert.equal(proof.status,200,await proof.clone().text());const cookie=proof.headers.get("set-cookie")!.split(";")[0]!;await proof.text();
 const accepted=await fetchWire(base+"/api/v1/whoami",{headers:{host:"fixture.local",cookie}});assert.equal(accepted.status,200);await accepted.text();
 const forged=await fetchWire(base+"/api/v1/whoami",{headers:{host:"evil.local",cookie}});assert.equal(forged.status,421);await forged.text();
});

test("remote HTTP backend accepts owner and admin tokens without second-factor-required error (M6A-S3)", async t => {
  const users = new MemoryUserDirectory();
  const password = "fixture-pass-not-a-real-secret", hash = await hashPassword(password);
  for (const role of ["owner", "admin"] as const) users.add({ id: role, username: role, role, passwordHash: hash });
  const { TokenService } = await import("../src/tokens.ts");
  const { MemoryTokenStore } = await import("../src/memory-stores.ts");
  const tokenStore = new MemoryTokenStore();
  const tokens = new TokenService({ store: tokenStore, clock: systemClock });
  const ownerTok = await tokens.create("owner", { name: "owner-remote-token", scopes: ["my.read"] });
  const adminTok = await tokens.create("admin", { name: "admin-remote-token", scopes: ["my.read"] });
  const sessions = new SessionStore(systemClock);
  const api = createApiServer({
    core: fakeCore(),
    users,
    tokens: tokenStore,
    sharedSessions: sessions,
    ownerToken: randomBytes(32).toString("hex"),
    remote: { publish: "tailnet", publicOrigin: "https://fixture.local" },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: (msg, f) => console.error(msg, f) },
  });
  const { url } = await api.listen();
  t.after(() => api.close());
  const base = url.replace("https:", "http:");
  const fetchWire = (url: string, init: RequestInit = {}): Promise<Response> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => (headers[k] = v));
      const body = typeof init.body === "string" ? init.body : undefined;
      if (body) headers["content-length"] = String(Buffer.byteLength(body));
      const req = request(url, { method: init.method ?? "GET", headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode!,
              headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v ?? ""])),
            }),
          ),
        );
      });
      req.on("error", reject);
      req.end(body);
    });

  const ownerRes = await fetchWire(base + "/api/v1/whoami", {
    headers: { host: "fixture.local", authorization: `Bearer ${ownerTok.token}` },
  });
  assert.equal(ownerRes.status, 200);
  const ownerBody = await ownerRes.json() as any;
  assert.equal(ownerBody.principal.id, "owner");

  const adminRes = await fetchWire(base + "/api/v1/whoami", {
    headers: { host: "fixture.local", authorization: `Bearer ${adminTok.token}` },
  });
  assert.equal(adminRes.status, 200);
  const adminBody = await adminRes.json() as any;
  assert.equal(adminBody.principal.id, "admin");
});
