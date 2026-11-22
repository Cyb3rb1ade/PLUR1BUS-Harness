import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { appendImportedKnowledge, formatImportedKnowledge } from "../../packages/core/src/knowledge/file.ts";
import { migrateLegacyKnowledge, rollbackKnowledgeMigration } from "../../packages/core/src/knowledge/migration.ts";
import { exporterMain } from "./lib.mjs";

const source="fixture:article", text="<context>&\nAuthorized text\n";
function bytes(file:string){
  return existsSync(file)?readFileSync(file,"utf8"):null;
}
function capture(fn:()=>unknown){
  try{return fn();}catch(error){
    if(!(error instanceof Error))throw error;
    return {error:"reason" in error&&typeof error.reason==="string"?error.reason:error.message};
  }
}

function appendCase(name:string){
  const root=mkdtempSync(join(tmpdir(),"knowledge-v-"));
  const file=join(root,"memory","KNOWLEDGE.md");
  try{
    if(name==="existing"){
      mkdirSync(join(root,"memory"),{recursive:true});
      writeFileSync(file,"\ufeff# Earlier fixture\n");
    }
    const append=()=>{const {path:_path,...result}=appendImportedKnowledge(root,text,source);return result;};
    const first=append(),second=append();
    return {name,first,second,contents:bytes(file)};
  }finally{rmSync(root,{recursive:true,force:true});}
}

function migrationCase(name:string){
  const root=mkdtempSync(join(tmpdir(),"knowledge-migration-v-"));
  const file=join(root,"memory","KNOWLEDGE.md");
  const state=join(root,".knowledge-migration-v1");
  const meta=join(state,"report.json");
  const before="# Existing fixture\n";
  try{
    writeFileSync(join(root,"USER.md"),"Always exclude this fixture");
    if(name!=="no legacy"){
      const value=name==="bad encoding"?Buffer.from([0xc3,0x28]):name==="utf16"
        ?Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from("Wide fixture","utf16le")])
        :"<note> & evidence\n";
      writeFileSync(join(root,"knowledgepool.md"),value);
      if(name==="both")writeFileSync(join(root,"memories.md"),"Second file");
    }
    if(["restore","drift","bad backup","resume before","resume after","conflict before"].includes(name)){
      mkdirSync(join(root,"memory"),{recursive:true});writeFileSync(file,before);
    }
    if(name==="bad report"){
      mkdirSync(state,{recursive:true});writeFileSync(meta,'{"version":1,"state":"unknown"}');
    }
    const initial=capture(()=>migrateLegacyKnowledge(root,root));
    let follow=null;
    if(["restore","remove","drift","bad backup"].includes(name)){
      if(name==="drift")writeFileSync(file,"External fixture edit");
      if(name==="bad backup")writeFileSync(join(state,"before.md"),"Changed backup");
      follow=capture(()=>rollbackKnowledgeMigration(root,root));
    }else if(["resume before","resume after","conflict before"].includes(name)){
      const saved=JSON.parse(readFileSync(meta,"utf8"));saved.state="prepared";
      writeFileSync(meta,JSON.stringify(saved,null,2)+"\n");
      if(name!=="resume after")writeFileSync(file,name==="resume before"?before:"External fixture edit");
      follow=capture(()=>migrateLegacyKnowledge(root,root));
    }else if(name==="both"){
      follow=capture(()=>migrateLegacyKnowledge(root,root));
    }
    return {name,initial,follow,contents:bytes(file),beforeBackup:bytes(join(state,"before.md")),
      afterBackup:bytes(join(state,"after.md")),report:bytes(meta)};
  }finally{rmSync(root,{recursive:true,force:true});}
}

export function buildKnowledgeFileVectors(){
  return {file:{text,source,formatted:formatImportedKnowledge(text,source),append:["new","existing"].map(appendCase),
    migration:["no legacy","new","both","restore","remove","drift","bad backup","resume before","resume after","conflict before",
      "utf16","bad encoding","bad report"].map(migrationCase)}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await exporterMain({area:"knowledge",build:buildKnowledgeFileVectors});
}
