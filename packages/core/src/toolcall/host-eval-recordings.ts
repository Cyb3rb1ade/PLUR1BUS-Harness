import { HOST_EVAL_SUITE, HOST_SCENARIO_IDS, type HostEvalCall, type ModelRef } from './host-eval.ts';
export type HostRecording = ModelRef & {wireFormat:string;suite:string;recordedAt:string;transcripts:{id:string;calls:HostEvalCall[]}[]};
/** Missing evidence is different from a model failure: all corpus IDs must exist before replay. */
export function validateHostRecordings(raw: unknown): HostRecording[] {
  const data=raw as {schema?:unknown;models?:unknown} | null;
  if(data?.schema!=='plur1bus.host-eval-recordings/1' || !Array.isArray(data.models))throw Error('invalid recordings document');
  const seen=new Set<string>();
  for(const value of data.models) {
    const r=value as HostRecording;
    const key=JSON.stringify([r?.provider,r?.model]);
    if(!r || typeof r.provider!=='string' || typeof r.model!=='string' || typeof r.wireFormat!=='string' ||
      seen.has(key) || r.suite!==HOST_EVAL_SUITE || !Number.isFinite(Date.parse(r.recordedAt)) || !Array.isArray(r.transcripts) ||
      r.transcripts.length!==HOST_SCENARIO_IDS.length || new Set(r.transcripts.map(t=>t?.id)).size!==HOST_SCENARIO_IDS.length ||
      r.transcripts.some(t=>!t || !HOST_SCENARIO_IDS.includes(t.id) || !Array.isArray(t.calls) || t.calls.length>256 ||
        t.calls.some(c=>!c || typeof c.name!=='string' || !('args' in c))))throw Error('invalid or incomplete host-eval recording');
    seen.add(key);
  }
  return data.models as HostRecording[];
}
