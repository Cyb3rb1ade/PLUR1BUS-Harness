import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createRequire } from "node:module";
// Use the schema package’s declared validator, matching its installed version.
const Ajv=createRequire(new URL("../packages/config-schema/package.json",import.meta.url))("ajv");
import { loadReasoningTable, lookupReasoning } from "../packages/core/src/discovery/reasoning.ts";
import { SHIPPED_PRICE_TABLES } from "../packages/core/src/budget/prices.ts";
const schema=JSON.parse(readFileSync(new URL("../packages/core/catalog/reasoning-metadata.schema.json",import.meta.url),"utf8"));
const validate=new Ajv({allErrors:true,strict:false}).compile(schema);
export function checkReasoningMetadata(raw, known=[]) {
  if(!validate(raw))throw new Error(`reasoning metadata schema: ${new Ajv().errorsText(validate.errors)}`);
  const table=loadReasoningTable(raw),missing=[];
  for(const item of known){
    const id=typeof item==="string"?item:item.id;
    const vendor=typeof item==="string"?(id.startsWith("claude-")?"anthropic":id.startsWith("gemini-")?"google":undefined):item.vendor;
    if(!lookupReasoning(table,vendor,id))missing.push(`${vendor?`${vendor}/`:""}${id}`);
  }
  return {revision:table.revision,missing:[...new Set(missing)].sort()};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try {
    const path=process.argv[2]?resolve(process.argv[2]):new URL("../packages/core/catalog/reasoning-metadata.json",import.meta.url);
    const known=SHIPPED_PRICE_TABLES.flatMap(table=>Object.keys(table.models));
    const result=checkReasoningMetadata(JSON.parse(readFileSync(path,"utf8")),known);
    for(const id of result.missing)console.log(`INFO reasoning metadata: no entry for known model ${id}`);
    console.log(`reasoning metadata ${result.revision}: schema and patterns valid; ${result.missing.length} coverage hints`);
  }catch(error){console.error(String(error));process.exitCode=1;}
}
