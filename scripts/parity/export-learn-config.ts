import { pathToFileURL } from "node:url";
import type { HarnessConfig } from "@plur1bus/config-schema";
import { LearnService } from "../../packages/core/src/dreams/learn/service.ts";
import { LearnStore } from "../../packages/core/src/dreams/learn/store.ts";
import { learnConfig, learnTargets } from "../../packages/core/src/dreams/learn/config.ts";
import { calibration } from "../../packages/core/src/dreams/learn/calibration.ts";
import { exporterMain } from "./lib.mjs";

const target={scope:"agent" as const,owner:"ada",agentId:"alpha"};
const now=1_750_000_000_000;

export function buildLearnConfigVectors(){
  const fixtures:unknown[]=[];
  for(const name of ["default","multiple","disabled","matching explicit"]){
    const config=(name==="default"?{}:name==="multiple"?{dreams:{learn:{windowDays:10,maxSessions:3,maxTokens:7000,
      agents:{beta:{owner:"ben",enabled:true,focus:"beta focus"},alpha:{owner:"ada",enabled:true}},
      projects:{workspace:{owner:"ada",agentId:"alpha",enabled:true,focus:"project focus"},incomplete:{owner:"ada"}},
      installation:{owner:"ada",agentId:"alpha",enabled:true}}}}:
        {dreams:{learn:{agents:{alpha:{owner:"ada",enabled:name==="matching explicit",focus:"narrow focus"}},
          projects:{unset:{owner:"ada",agentId:"beta"}}}}}) as HarnessConfig;
    const store=new LearnStore(":memory:");
    const controller=new AbortController();
    const svc=new LearnService({store,config:()=>config,now:()=>now,principal:()=>null,mayReadTarget:()=>false,signal:controller.signal,
      source:{sessions:()=>[],mayRead:()=>false,transcript(){throw Error("no transcript expected");}},
      model:{async complete(){throw Error("no model expected");}},readPort:async()=>null,card:async()=>null});
    try{
      const targets=learnTargets(config);
      fixtures.push({name,config:JSON.stringify(config),expected:{targets,
        windows:targets.map(t=>svc.window(t)),settings:targets.map(t=>learnConfig(config,t)),fallback:learnConfig(config,target),
        wake:svc.nextRunAt(),calibration:calibration(store,target,["small","large","small"])}});
    }finally{store.close();}
  }
  return {config:fixtures};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await exporterMain({area:"learn",build:buildLearnConfigVectors});
}
