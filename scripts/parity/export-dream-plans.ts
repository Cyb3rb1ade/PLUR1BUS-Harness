import { pathToFileURL } from "node:url";
import { DreamScheduler } from "../../packages/core/src/dreams/scheduler.ts";
import { DreamStore } from "../../packages/core/src/dreams/store.ts";
import { type Phase } from "../../packages/core/src/dreams/types.ts";
import { exporterMain } from "./lib.mjs";

export function buildDreamPlanVectors() {
  const cases = [
    { name: "minimum corpus", phase: "rem", captures: 2 },
    { name: "ready", phase: "rem", captures: 3 },
    { name: "no jobs", phase: "deep", captures: 3 },
    { name: "already claimed", phase: "rem", captures: 3 },
    { name: "breaker open", phase: "deep", captures: 3, breaker: "future" },
    { name: "breaker expires at the boundary", phase: "deep", captures: 3, breaker: "now" },
    { name: "light ignores sweep breaker", phase: "light", captures: 1, breaker: "future" },
    { name: "local date before UTC midnight", phase: "light", captures: 1, timezone: "America/Los_Angeles" },
    { name: "daylight saving schedules", phase: "deep", captures: 3, timezone: "America/New_York", now: Date.parse("2025-03-09T06:55:00Z") },
    { name: "unsupported default timezone", phase: "rem", captures: 3, timezone: "invalid-zone", stagger: 0 },
  ] as const satisfies readonly { name: string; phase: Phase; captures: number; breaker?: "future" | "now"; timezone?: string; now?: number; stagger?: number }[];
  const suite = cases.map(value => {
    const spec: (typeof cases)[number] & { now?: number; timezone?: string; stagger?: number; breaker?: "future" | "now" } = value;
    const { name, phase, captures } = spec;
    const now = spec.now ?? Date.parse("2025-11-05T01:00:00Z");
    const settings = { timezone:spec.timezone ?? "UTC", staggerWindowS:spec.stagger ?? 1800 };
    const breakerUntil = spec.breaker === "future" ? now + 1 : spec.breaker === "now" ? now : null;
    const ordered = [
      { name:"gc-run", needsLlm:false },
      { name:"rem-dream", needsLlm:true },
      { name:"discover-semantic-links", needsLlm:false },
      { name:"light-dream", needsLlm:true },
      { name:"consolidate-daily", needsLlm:true },
      { name:"other-job", needsLlm:true },
    ];
    const jobs = name === "no jobs" ? [] : ordered;
    const agentId = "agent-fixture";
    const store = new DreamStore(":memory:");
    try {
      const scheduler = new DreamScheduler({
        store, engine:{jobs:{ list:()=>jobs.map(job=>({...job,singleton:false})),
          async run(){ throw new Error("planning cannot run a job"); } }},
        clock:{ now:()=>now, setTimer(){ throw new Error("planning cannot arm a timer"); } },
        logger:{ info(){}, warn(){}, error(){} }, logsDir:"unused", agents:()=>[agentId],
        defaultTimezone:settings.timezone, staggerWindowS:settings.staggerWindowS,
      });
      scheduler.syncAgents();
      for(let count=0; count<captures; count++) store.recordCapture(agentId, 5, now);
      if(breakerUntil!==null) store.updateSchedule(agentId,"rem",{breakerState:"open",breakerUntil});
      if(name==="already claimed"){
        const key=scheduler.plan(agentId,phase).idempotencyKey;
        store.insertRun({runId:"existing",agentId,phase,jobId:"fixture",partition:"agent-private",idempotencyKey:key,
          trigger:"cron",scheduledFor:null,startedAt:now,logPath:null});
        if(!store.claimKey("existing",key)) throw new Error("fixture claim failed");
      }
      const result=scheduler.plan(agentId,phase);
      const times=store.listSchedules(agentId).map(({phase,nextRunAt,staggerOffsetS,timezone})=>({phase,nextRunAt,staggerOffsetS,timezone}));
      return {name,now,phase,captures,settings,jobs,breakerUntil,result,times};
    } finally { store.close(); }
  });
  return { plans: suite };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area:"dreams", build:buildDreamPlanVectors });
}
