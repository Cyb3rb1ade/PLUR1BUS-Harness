import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sessionUsage } from "../../src/rpc/session-usage.ts";
test("session usage joins every settled/retry call once, unknown/pending cost stays null", t => {
  const root = mkdtempSync(join(tmpdir(), "admin-usage-")), file = join(root,"budget.sqlite"); t.after(() => rmSync(root,{ recursive: true, force: true }));
  const db = new DatabaseSync(file); t.after(() => db.close());
  db.exec(`CREATE TABLE budget_call(id TEXT,session TEXT,model TEXT,state TEXT,cost INTEGER,ts INTEGER);
    CREATE TABLE usage_event(request_id TEXT,input_tokens INTEGER,output_tokens INTEGER);
    INSERT INTO budget_call VALUES ('one','first','model-a','settled',5,1),('two','first','model-b','settled',7,2),('third','other','model-c','reserved',9,3);
    INSERT INTO usage_event VALUES ('budget-call:one',10,2),('budget-call:two',20,3);`);
  const first = sessionUsage(file,['first']);
  assert.equal(first.size,1); assert.deepEqual(first.get('first'),{ model: 'model-b',usage:{ inputTokens:30,outputTokens:5,costMicros:12,pendingCalls:0 } });
  assert.equal(sessionUsage(file,['other']).get('other')?.usage.costMicros,null);
  db.exec("INSERT INTO budget_call VALUES ('unknown','first','model-d','settled',NULL,4); INSERT INTO usage_event VALUES ('budget-call:unknown',2,1)");
  assert.equal(sessionUsage(file,['first']).get('first')?.usage.costMicros,null);
  assert.equal(sessionUsage(join(root,'missing.sqlite'),['first']).size,0);
});

test("real budget admission/settlement is joined by its existing prefixed request id", async t => {
  const { createCallBudget,PriceBook,SHIPPED_PRICE_TABLES }=await import("../../src/budget/index.ts");
  const root=mkdtempSync(join(tmpdir(),"admin-real-usage-")),file=join(root,"budget.sqlite");
  const budget=createCallBudget({path:file,clock:{now:()=>100_000},prices:new PriceBook(SHIPPED_PRICE_TABLES)});
  t.after(()=>{budget.close();rmSync(root,{recursive:true,force:true});});
  const admission=budget.checkBeforeCall({principal:"person",agent:"alpha",project:"direct",model:"offline-unpriced-model",session:"session-one",turn:"turn-one",estimatedInputTokens:10,maxOutputTokens:20});
  assert.equal(admission.kind,"allow"); if (admission.kind!=="allow") return;
  budget.settle(admission.reservationId,{inputTokens:11,outputTokens:4});
  assert.deepEqual(sessionUsage(file,["session-one"]).get("session-one"),{model:"offline-unpriced-model",usage:{inputTokens:11,outputTokens:4,costMicros:null,pendingCalls:0}});
});
