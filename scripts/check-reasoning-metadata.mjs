import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createRequire } from "node:module";
// Use the schema package’s declared validator, matching its installed version.
const Ajv=createRequire(new URL("../packages/config-schema/package.json",import.meta.url))("ajv");
import { loadMetadataTable } from "../packages/core/src/discovery/metadata.ts";
import modelMetadata from "../packages/core/catalog/model-metadata.json" with { type: "json" };
import { loadReasoningTable, lookupReasoning } from "../packages/core/src/discovery/reasoning.ts";
const schema=JSON.parse(readFileSync(new URL("./reasoning-metadata.schema.json",import.meta.url),"utf8"));
const validate=new Ajv({allErrors:true,strict:false}).compile(schema);
// Metadata also describes open-ended model families. Only exact literal patterns and explicit aliases name
// concrete models; a regex is never a model ID and we do not invent examples for a family.
function literalModelId(pattern) {
  const body=pattern.slice(1,-1);
  let id="";
  for(let i=0;i<body.length;i++){
    const char=body[i];
    if(char==="\\"){
      const escaped=body[++i];
      if(!escaped || !"\\^$.*+?()[]{}|/-".includes(escaped))return null;
      id+=escaped;
    }else{
      if("^$.*+?()[]{}|".includes(char))return null;
      id+=char;
    }
  }
  return id || null;
}

/** Concrete chat models in the bundled D112 table, with vendor identity and aliases preserved. */
export function knownModelsFromMetadata(raw=modelMetadata) {
  const table=loadMetadataTable(raw),known=new Map();
  for(const [section,rules] of table.sections){
    const vendor=section==="generic"?undefined:section;
    for(const {rule} of rules){
      if(rule.kind!=="chat")continue;
      const exact=literalModelId(rule.pattern);
      for(const id of [...(exact?[exact]:[]),...(rule.aliases??[])]){
        known.set(JSON.stringify([vendor,id]),{...(vendor?{vendor}:{}),id});
      }
    }
  }
  return [...known.values()].sort((a,b)=>{
    const left=`${a.vendor??""}/${a.id}`,right=`${b.vendor??""}/${b.id}`;
    return left<right?-1:left>right?1:0;
  });
}

export function checkReasoningMetadata(raw, known=knownModelsFromMetadata()) {
  if(!validate(raw))throw new Error(`reasoning metadata schema: ${new Ajv().errorsText(validate.errors)}`);
  const table=loadReasoningTable(raw),missing=[];
  for(const item of known){
    const id=typeof item==="string"?item:item.id;
    const vendor=typeof item==="string"?(id.startsWith("claude-")?"anthropic":id.startsWith("gemini-")?"google":undefined):item.vendor;
    if(!lookupReasoning(table,vendor,id))missing.push(`${vendor?`${vendor}/`:""}${id}`);
  }
  return {revision:table.revision,checked:known.length,missing:[...new Set(missing)].sort()};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try {
    const path=process.argv[2]?resolve(process.argv[2]):new URL("../packages/core/catalog/reasoning-metadata.json",import.meta.url);
    const result=checkReasoningMetadata(JSON.parse(readFileSync(path,"utf8")));
    for(const id of result.missing)console.log(`INFO reasoning metadata: no entry for known model ${id}`);
    console.log(`reasoning metadata ${result.revision}: schema and patterns valid; ${result.checked} known models checked; ${result.missing.length} coverage hints`);
  }catch(error){console.error(String(error));process.exitCode=1;}
}
