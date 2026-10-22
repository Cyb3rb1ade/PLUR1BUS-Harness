import { test } from "node:test";
import assert from "node:assert/strict";
import { defaults, restartClassOf, tierOf, validate } from "../src/index.ts";

test("curated promotion cap is a nonnegative integer including unlimited zero, with core/advanced metadata",()=>{
  for(const cap of [0,1,100]){
    const cfg=defaults();cfg.engine={schicht15:{enabled:true,maxPromotionsPerRun:cap}};
    assert.equal(validate(cfg).ok,true);
  }
  for(const cap of [-1,0.5,"unlimited",null]){
    const cfg=defaults();cfg.engine={schicht15:{maxPromotionsPerRun:cap}};
    assert.equal(validate(cfg).ok,false,`invalid cap ${JSON.stringify(cap)}`);
  }
  assert.equal(restartClassOf("engine.schicht15.maxPromotionsPerRun"),"core");
  assert.equal(tierOf("engine.schicht15.maxPromotionsPerRun"),"advanced");
});
