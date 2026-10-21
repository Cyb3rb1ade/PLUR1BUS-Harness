import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeMediaSearch, mediaSearchMethods } from "../../src/composition/media-search.ts";
import { defaults } from "@plur1bus/config-schema";
import { FakePort, silentLogger } from "./fakes.ts";

describe("composeMediaSearch", () => {
  it("store put/delete drive the hook; prompt becomes the caption", async () => {
    const home = mkdtempSync(join(tmpdir(), "media-comp-"));
    const ws = join(home, "ws"); mkdirSync(ws);
    mkdirSync(join(home, "media", "owners"), { recursive: true });
    writeFileSync(join(home, "media", "owners", "out1.json"), JSON.stringify({ agentId: "bernd", userId: "u", connectionId: "" }));
    writeFileSync(join(home, "media", "owners", "out2.json"), JSON.stringify({ agentId: "bernd", userId: "u", connectionId: "" }));
    let listener: any;
    const store = { root: join(home, "media", "outputs"), addListener: (l: unknown) => { listener = l; return () => { listener = undefined; }; } };
    const port = new FakePort();
    const cfg = defaults();
    const c = await composeMediaSearch({ home, config: () => cfg, engine: {}, agents: { workspaceOf: () => ws }, logger: { ...silentLogger, debug() {} } as any, store: store as any, budget: null, testPort: port });
    assert.equal(c.kind, "memory");
    listener.onPut({ id: "out1", prompt: "a red kite", files: [{ path: "0.png", format: "png" }] });
    listener.onPut({ id: "out2", kind: "video", prompt: "a red kite in motion", files: [{ path: "0.mov", format: "mov" }] });
    listener.onDelete("out1");
    await c.hook.idle();
    // The hook runs concurrently; owner-file reads need not complete in enqueue order.
    // Assert each medium's data and scope by identity, rather than OS I/O completion order.
    assert.equal(port.indexed.length, 2);
    const image = port.indexed.find(record => record.mediaId === "out1");
    const video = port.indexed.find(record => record.mediaId === "out2");
    assert.ok(image); assert.ok(video);
    assert.equal(image.captionSource, "prompt");
    assert.equal(image.caption, "a red kite");
    assert.equal(image.scope.agentId, "bernd");
    assert.equal(video.kind, "video");
    assert.equal(video.mime, "video/quicktime");
    assert.deepEqual(port.removed, ["out1"]);
    await c.close();
    assert.equal(listener, undefined);
  });
  it("engine without media: disabled, no listener", async () => {
    const home = mkdtempSync(join(tmpdir(), "media-comp-"));
    let attached = false;
    const store = { root: home, addListener: () => { attached = true; return () => {}; } };
    const c = await composeMediaSearch({ home, config: () => defaults(), engine: {}, agents: { workspaceOf: () => undefined }, logger: { ...silentLogger, debug() {} } as any, store: store as any, budget: null });
    assert.equal(c.kind, "disabled");
    assert.equal(attached, false);
    await c.close();
  });
  it("mediaSearchMethods exposes the six handlers; a disabled index answers E_MEDIA_UNAVAILABLE", async () => {
    const home = mkdtempSync(join(tmpdir(), "media-comp-"));
    const c = await composeMediaSearch({ home, config: () => defaults(), engine: {}, agents: { workspaceOf: () => undefined }, logger: { ...silentLogger, debug() {} } as any, store: null, budget: null });
    const methods = mediaSearchMethods({ home, config: () => defaults(), agents: { workspaceOf: () => undefined } }, c);
    assert.deepEqual(Object.keys(methods).sort(), ["media.caption.set", "media.index.pause", "media.index.reindex", "media.index.resume", "media.index.status", "media.search"]);
    await c.close();
  });
});

describe('Engine 1.19 production media path',()=>{
 it('binds owned IDs/captions, rejects agent model drift and live cloud pin before encode',async()=>{
  const home=mkdtempSync(join(tmpdir(),'h2-runtime-'));const ws=join(home,'ws');mkdirSync(ws);
  mkdirSync(join(home,'media','owners'),{recursive:true});
  for(const id of ['photo','other','forged'])writeFileSync(join(home,'media','owners',`${id}.json`),JSON.stringify({agentId:'alice'}));
  const cfg=defaults();cfg.agents.alice={};cfg.memory.mediaEmbedding.backfill='manual';
  const indexed:any[]=[];const removed:string[]=[];let listener:any;
  const engine={media:{index:async(r:any)=>{indexed.push(r);return{state:'indexed',segments:1};},search:async()=>[],remove:async(id:string)=>{removed.push(id);},setCaption:async()=>{},
   status:()=>({enabled:true,provider:'local-transformers',model:'google/embeddinggemma-2',dim:768,fingerprint:'fp',counts:{indexed:0,pending:0,failed:0,unsupported:0},backfill:{state:'idle',done:0,total:0}}),
   backfill:{start:async()=>{},resume:async()=>{},pause:async()=>{},cancel:async()=>{}}}};
  let pinned=false;
  const c=await composeMediaSearch({home,config:()=>cfg,engine,hostFetchReady:true,agents:{workspaceOf:()=>ws},logger:{...silentLogger,debug(){}} as any,
   store:{root:join(home,'media','outputs'),addListener:(l:any)=>{listener=l;return()=>{};}} as any,budget:null,privacyPinned:()=>pinned});
  listener.onPut({id:'photo',prompt:'a green square',files:[{path:'0.png',format:'png'}]});await c.hook.idle();
  assert.equal(indexed.length,1);assert.equal(indexed[0].caption,'a green square');assert.deepEqual(indexed[0].scope,{agentId:'alice',scope:'agent-private'});
  listener.onDelete('photo');await c.hook.idle();assert.deepEqual(removed,[indexed[0].mediaId]);
  c.hook.onUploaded({mediaId:'forged',agentId:'bob',kind:'image',mime:'image/png',source:{bytes:new Uint8Array([1])},userCaption:'private'});
  await c.hook.idle();assert.equal(indexed.length,1);
  cfg.agents.alice.memory={mediaEmbedding:{model:'unavailable'}};
  listener.onPut({id:'other',prompt:'private',files:[{path:'0.png',format:'png'}]});await c.hook.idle();assert.equal(indexed.length,1);
  cfg.memory.mediaEmbedding.provider='cloud';pinned=true;
  await assert.rejects(c.port.search({text:'private',scope:{agentId:'alice',workspace:ws} as any,limit:1}),(e:any)=>e.error==='E_MEDIA_PRIVACY');
  await c.close();
 });
});
