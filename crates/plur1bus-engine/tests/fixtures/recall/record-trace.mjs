// RE-04/T6: actual pinned trace helpers; Node fixtures include a cut surrogate as UTF-16 units.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MARKERS, forms } from "../../../../../tests/system/redaction-fixture.ts";

const root = process.env.PLUR1BUS_ENGINE_SRC;
assert.ok(root);
assert.equal(process.version, "v24.21.0");
const source = JSON.parse(readFileSync(new URL("./namespace-sources.json", import.meta.url), "utf8")).runtime;
const file = "lib/recall-decision-trace.js";
assert.equal(createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex"), source.sha256[file]);
const node = await import(pathToFileURL(path.join(root, file)));
const inputs = ["", "short", "alpha beta gamma", "x".repeat(200), "😀😀😀", "a\u0001b\t c\u00a0d", "é🤖word next", "\uFEFFtrim\u2003this "];
const limits = [1, 2, 3, 4, 5, 7, 12, 160];
const units = text => Array.from({length:text.length}, (_,i) => text.charCodeAt(i));
const record = () => inputs.map(input => limits.map(limit => units(node.textPreview(input, limit))));
const expected = record();
assert.deepEqual(record(), expected);
const config = {maxCandidates:2,maxDecisions:2,maxGuards:1,maxStoreDecisions:1,maxTextPreviewChars:12};
const streams = {
  candidates: [0,1,2].map(n => ({id:`id-${n}`,source:"vector",category:"general",status:"active",preview:"alpha beta gamma delta",score:0.25,vectorScore:0.125,namespace:"private-1"})),
  decisions:[{memoryId:"id-0",action:"rejection",stage:"acl",reason:"synthetic denied"},{memoryId:"id-1",action:"inclusion",stage:"rerank",reason:"synthetic included"},{memoryId:"id-2",action:"deduped",stage:"dedup",reason:"synthetic duplicate"}],
  guards:[{name:"old",passed:true},{name:"soft-budget",passed:false,reason:"soft_budget_fallback"}],
  storeDecisions:[{memoryId:"old",action:"stored"},{memoryId:"new",action:"rejected",reason:"synthetic denied"}],
};
const normalize = value => {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["traceId","createdAt","addedAt","recordedAt"].includes(key)).map(([key,v]) => [key,normalize(v)]));
};
function capture() {
  const trace = node.createRecallDecisionTrace({...config,query:"alpha beta gamma delta"});
  for (const entry of streams.candidates) node.addTraceCandidate(trace, {...entry,text:entry.preview});
  for (const entry of streams.decisions) node.addTraceDecision(trace, entry);
  for (const entry of streams.guards) node.addTraceGuard(trace, entry);
  for (const entry of streams.storeDecisions) node.addTraceStoreDecision(trace, entry);
  node.summarizeTrace(trace);
  return normalize(JSON.parse(JSON.stringify(trace)));
}
const trace = capture(); assert.deepEqual(capture(),trace);
const output = {recordedFrom:{source:{commit:source.commit,sha256:{[file]:source.sha256[file]}},node:process.version},inputs,limits,expected,config,streams,trace,markers:MARKERS.map(marker => ({marker,forms:forms(marker)}))};
writeFileSync(new URL("./golden/runtime-trace.json",import.meta.url),`${JSON.stringify(output,null,2)}\n`);
console.log(`Recorded ${inputs.length * limits.length} lossless previews and capped trace streams twice; imported shared redaction markers`);
