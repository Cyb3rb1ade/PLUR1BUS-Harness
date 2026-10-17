import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LicenceLedger } from "../../src/licences/ledger.ts";
import { checkMemorySelection,memoryModel } from "../../src/licences/memory.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
test("full model/revision/actor/time/licence acceptance is audited and survives reopening",t=>{
 const home=mkdtempSync(join(tmpdir(),"licences-"));t.after(()=>rmSync(home,{recursive:true,force:true}));const audit=memoryAuditSink(),path=join(home,"licences.sqlite"),model=memoryModel("jinaai/jina-embeddings-v3");
 const ledger=new LicenceLedger(path,audit,()=>12345);const change=[{key:"engine.embedding.local.model",value:model.model}];
 assert.throws(()=>checkMemorySelection(ledger,"owner",change));const acceptance=ledger.confirm("owner",model.model,model.licence,model.revision,"memory");ledger.close();
 const reopened=new LicenceLedger(path,audit,()=>99999);t.after(()=>reopened.close());assert.deepEqual(reopened.list(),[acceptance]);assert.equal(acceptance.who,"owner");assert.equal(acceptance.at,new Date(12345).toISOString());assert.equal(acceptance.revision.length,40);
 checkMemorySelection(reopened,"owner",change);assert.throws(()=>checkMemorySelection(reopened,"other",change));assert.equal(audit.events[0]!.action,"model.licence.confirmed");
});
test("audit failure prevents confirmation persistence",()=>{
 const ledger=new LicenceLedger(":memory:",{append(){throw Error("disk-full");}},()=>1);try{assert.throws(()=>ledger.confirm("owner","model","licence","revision","voice"));assert.deepEqual(ledger.list(),[]);}finally{ledger.close();}
});

test("confirmation for one pinned revision cannot authorize another revision",()=>{
 const ledger=new LicenceLedger(":memory:",memoryAuditSink(),()=>1),m=memoryModel("jinaai/jina-embeddings-v3");
 try {
  ledger.confirm("owner",m.model,m.licence,m.revision,"memory");
  assert.throws(()=>checkMemorySelection(ledger,"owner",[{key:"engine.embedding.local",value:{model:m.model,revision:"other"}}]));
  assert.throws(()=>checkMemorySelection(ledger,"owner",[{key:"engine.embedding.local.revision",value:"other"}],{engine:{embedding:{local:{model:m.model}}}}));
 }finally{ledger.close();}
});
