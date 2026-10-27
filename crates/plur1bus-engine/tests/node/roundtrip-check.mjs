// Cross-runtime store reader for engine pin 9f34008c143c5da87b2194b5a28442b407ff8ba7.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
const args=process.argv.slice(2);
if(args[0]==="--sqlite"){
  const {checkSqlite}=await import("./sqlite-check.mjs");
  console.log(JSON.stringify(await checkSqlite(args[1])));
}else if(args[0]==="--neo"){
  const {checkNeo}=await import("./neo-check.mjs");
  console.log(JSON.stringify(await checkNeo(args[1],{append:args.includes("--append")})));
}else if(args[0]==="--lock"){
  await import("./lock-check.mjs");
}else{
  let engineRoot;
  try{engineRoot=path.dirname(createRequire(path.join(process.cwd(),"package.json")).resolve("@cyb3rb1ade/plur1bus-memory/package.json"));}
  catch{throw new Error("run pnpm test:prep (the engine package is not installed)");}
  const {MemoryDB}=await import(pathToFileURL(path.join(engineRoot,"engine/store/memory-db.js")));
  const db=new MemoryDB(args[0],384,null,{readOnly:true});
  await db.init();
  try{
    const rows=await db.table.query().toArray();
    assert.equal(rows.length,Number(args[1]));
    console.log(JSON.stringify({count:rows.length,ids:rows.map(row=>row.id).sort(),identityStatus:db.identityStatus,textType:String((await db.table.schema()).fields.find(field=>field.name==="text").type)}));
  }finally{await db.shutdown();}
}
