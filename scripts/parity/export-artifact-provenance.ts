import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ArtifactProvenance, SelfKnowledgePolicy, type ArtifactChange } from "../../packages/core/src/skill-mining/artifact-policy.ts";
import { RpcError } from "../../packages/core/src/rpc/errors.ts";
import { exporterMain } from "./lib.mjs";

export async function buildArtifactProvenanceVectors(){
  const dir=mkdtempSync(join(tmpdir(),"skill-artifact-"));
  const file=join(dir,"NOTES.md");
  writeFileSync(file,"Original fixture");
  const store=new ArtifactProvenance(":memory:");
  const proposals:Omit<ArtifactChange,"path">[]=[];
  const audit:unknown[]=[];
  const first=store.inspect(file);
  const digest=createHash("sha256").update(first.path).digest("hex");
  const gate=new SelfKnowledgePolicy(store,{async propose({path,...rest}){
    if(path!==first.path)throw Error("fixture canonical path changed");
    proposals.push(rest);return {proposalId:"proposal"};
  }},({target,...entry})=>audit.push({...entry,target:target===digest?"artifact":target}));
  const snapshot=()=>{const {author,hash}=store.inspect(file);return {author,hash};};
  const refusal=(action:()=>void)=>{
    try{action();return null;}catch(error){if(!(error instanceof RpcError))throw error;return error.error;}
  };
  try{
    const defaultPolicy=gate.writeApproval;
    const humanDefault=await gate.request(file,"first proposal");
    const refusedAttribution=refusal(()=>store.attribute(file,"agent","admin"));
    const refusedPolicy=refusal(()=>gate.setWriteApproval(false,"admin"));
    gate.setWriteApproval(false,"owner");
    const humanOptOut=await gate.request(file,"second proposal");
    store.attribute(file,"agent","owner");
    const agent=snapshot();
    const agentOptOut=await gate.request(file,"agent write route");
    gate.setWriteApproval(true,"owner");
    const agentOptIn=await gate.request(file,"third proposal");
    writeFileSync(file,"Manual fixture edit");
    const afterManual=snapshot();
    return {"artifact-provenance":{initial:{author:first.author,hash:first.hash},defaultPolicy,humanDefault,refusedAttribution,
      refusedPolicy,humanOptOut,agent,agentOptOut,agentOptIn,afterManual,proposals,audit}};
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await exporterMain({area:"skills",build:buildArtifactProvenanceVectors});
}
