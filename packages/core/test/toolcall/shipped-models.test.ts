import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shippedModels, setupDefault, pendingShippedModels, requiredShippedModels, advisoryShippedModels } from '../../../../config/shipped-models.ts';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { shippedReleaseGate, HOST_EVAL_SUITE, HOST_SCENARIO_IDS } from '../../src/toolcall/host-eval.ts';

test('setup only preselects owner-confirmed pins actually discovered for that provider', () => {
  assert.deepEqual(shippedModels.map(m=>m.provider), ['anthropic','openai','google','ollama']);
  const available=shippedModels.map(m=>({provider:m.provider,id:m.model}));
  assert.equal(setupDefault('anthropic',available),'anthropic/claude-sonnet-5-5');
  assert.equal(setupDefault('anthropic',[]),'');
  for(const provider of ['openai','google','ollama','xai','openrouter','custom']) assert.equal(setupDefault(provider,available),'');
  assert.equal(pendingShippedModels().length,3);
});
test('only owner-confirmed pins are mandatory release coverage; pending candidates are advisory', () => {
  assert.deepEqual(requiredShippedModels(),[{provider:'anthropic',model:'claude-sonnet-5-5'}]);
  assert.deepEqual(advisoryShippedModels().map(m=>`${m.provider}/${m.model}`),['openai/gpt-6-astra','google/gemini-3.8-flash','ollama/qwen3:8b']);
  assert.deepEqual(shippedModels.filter(m=>m.approval!=='owner_confirmed').map(m=>m.approval),['pending_owner','pending_owner','pending_owner']);
});
test('release gate uses exactly the owner-confirmed shipped pins and refuses missing recordings', async () => {
  const dir=await mkdtemp(join(tmpdir(),'d106-release-'));
  try {
    await assert.rejects(promisify(execFile)(process.execPath,['--experimental-strip-types','--conditions=source','--no-warnings=ExperimentalWarning',fileURLToPath(new URL('../../../../scripts/eval/tool-eval-host.ts',import.meta.url)),'--recorded','--require-release'],{env:{...process.env,PLUR1BUS_HOST_EVAL_OUT:dir,PLUR1BUS_HOST_EVAL_MODELS:'[]'}}),e=>!!e && typeof e==='object' && 'code' in e && e.code===1);
    const gate=JSON.parse(await readFile(join(dir,'gate.json'),'utf8'));
    assert.equal(gate.passed,false);
    // Mandatory coverage is exactly the owner-confirmed pins; the pending candidates are listed as advisory.
    assert.deepEqual(gate.models.map((m:{provider:string;model:string})=>({provider:m.provider,model:m.model})),requiredShippedModels());
    assert.deepEqual(gate.advisory.map((m:{provider:string;model:string})=>`${m.provider}/${m.model}`),advisoryShippedModels().map(m=>`${m.provider}/${m.model}`));
    assert.deepEqual(gate.pendingOwnerOrDiscovery,advisoryShippedModels().map(m=>`${m.provider}/${m.model}`));
    assert.equal(gate.freshnessRequired,true);
    // A Windows checkout under Git for Windows' core.autocrlf=true has CRLF line ends; the patterns below are written with \n.
    const lf=(text: string)=>text.replaceAll('\r\n','\n');
    const ci=lf(await readFile(new URL('../../../../.github/workflows/ci.yml',import.meta.url),'utf8'));
    // Owner decision 2026-10-19: PR/main CI runs only the fixture; the fail-closed gate runs only in the release workflow.
    const hostJob=ci.slice(ci.indexOf('\n  host-tool-eval:\n'),ci.indexOf('\n  perf-startup:'));
    assert.match(hostJob,/tool-eval-host\.ts\n/);
    assert.doesNotMatch(ci,/--require-release/);
    assert.doesNotMatch(ci,/--recorded/);
    const rel=lf(await readFile(new URL('../../../../.github/workflows/release.yml',import.meta.url),'utf8'));
    assert.match(rel,/\non:\n  push:\n    tags: \['v\*'\]/);
    const gateJob=rel.slice(rel.indexOf('\n  release-gate:\n'),rel.indexOf('\n  attest:\n'));
    assert.match(gateJob,/\n    needs: meta\n/);
    assert.equal(gateJob.match(/--require-release/g)?.length,1);
    assert.match(gateJob,/tool-eval-host\.ts --recorded --require-release \|\| rc=\$\?\n/);
    // The step records the exit code (so the report is still uploaded) and a later step re-raises it: the gate stays fail-closed.
    assert.match(gateJob,/echo "rc=\$\{rc\}" >> "\$GITHUB_OUTPUT"/);
    assert.match(gateJob,/if: steps\.gate\.outputs\.rc != '0'\n        run: exit 1\n/);
    assert.doesNotMatch(gateJob,/continue-on-error/);
    assert.equal(rel.match(/--require-release/g)?.length,1);
    assert.match(rel,/\n  attest:\n    needs: \[meta, release-gate\]\n/);
    assert.match(rel,/\n  build:\n    needs: \[meta, attest\]\n/);
    const owners=await readFile(new URL('../../../../.github/CODEOWNERS',import.meta.url),'utf8');
    assert.match(owners,/\/config\/shipped-models.json @Cyb3rb1ade/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('owner confirmation alone cannot preselect a documentation-only OpenAI or Google candidate', async () => {
  const {confirmedShippedModel}=await import('../../../../config/shipped-models.ts');
  for(const provider of ['openai','google']) {
    assert.equal(confirmedShippedModel({provider,approval:'owner_confirmed',discovery:'documentation_only'}),false);
    assert.equal(confirmedShippedModel({provider,approval:'owner_confirmed',discovery:'authenticated_models_list'}),true);
  }
});
test('recording replay refuses a missing corpus ID even if 19 of 20 calls could pass', async () => {
  const {validateHostRecordings}=await import('../../src/toolcall/host-eval-recordings.ts');
  const {HOST_SCENARIOS,HOST_EVAL_SUITE}=await import('../../src/toolcall/host-eval.ts');
  const recording={provider:'fixture',model:'fixture',wireFormat:'chat_completions',suite:HOST_EVAL_SUITE,recordedAt:new Date().toISOString(),transcripts:HOST_SCENARIOS.map(s=>({id:s.id,calls:structuredClone(s.transcript)}))};
  const doc={schema:'plur1bus.host-eval-recordings/1',models:[recording]};
  assert.equal(validateHostRecordings(doc).length,1);
  recording.transcripts[19]!.id='foreign-id';
  assert.throws(()=>validateHostRecordings(doc),/incomplete/);
});

const gateReport=(provider:string,model:string,ageMs:number,evidence:'recorded'|'fake'='recorded')=>({schema:'plur1bus.host-tool-eval/1' as const,suite:HOST_EVAL_SUITE,provider,model,evidence,generatedAt:new Date(Date.now()-ageMs).toISOString(),status:'completed' as const,scenarios:HOST_SCENARIO_IDS.map(id=>({id,passed:true,policyEscapes:0})),successRate:1,policyEscapes:0});
const DAY=86400000;
const [required,advisory]=[requiredShippedModels(),advisoryShippedModels()];
const pin=requiredShippedModels()[0]!;
test('PR-side replay of a reviewed recording passes however old it is (no freshness outside release qualification)', () => {
  const gate=shippedReleaseGate(required,advisory,[gateReport(pin.provider,pin.model,90*DAY)],false);
  assert.equal(gate.passed,true);
  assert.equal(gate.freshnessRequired,false);
  assert.equal(gate.models[0]!.label,'supported');
});
test('release qualification fails a stale recording of a mandatory pin and passes a fresh one', () => {
  const stale=shippedReleaseGate(required,advisory,[gateReport(pin.provider,pin.model,8*DAY)],true);
  assert.equal(stale.passed,false);
  assert.equal(stale.models[0]!.label,'unknown');
  assert.equal(shippedReleaseGate(required,advisory,[gateReport(pin.provider,pin.model,6*DAY)],true).passed,true);
});
test('no fabricated evidence passes in either mode: missing, synthetic or future-dated recordings of a mandatory pin', () => {
  for(const requireRelease of [false,true]) {
    assert.equal(shippedReleaseGate(required,advisory,[],requireRelease).passed,false);
    assert.equal(shippedReleaseGate(required,advisory,[gateReport(pin.provider,pin.model,0,'fake')],requireRelease).passed,false);
    assert.equal(shippedReleaseGate(required,advisory,[gateReport(pin.provider,pin.model,-DAY)],requireRelease).passed,false);
    const below=gateReport(pin.provider,pin.model,0); below.scenarios[0]!.passed=false; below.scenarios[1]!.passed=false; below.successRate=18/20;
    assert.equal(shippedReleaseGate(required,advisory,[below],requireRelease).passed,false);
  }
  assert.equal(shippedReleaseGate([],advisory,[],true).passed,false);
});
test('a pending candidate without a recording warns but does not block; confirming it makes it mandatory', () => {
  const reports=[gateReport(pin.provider,pin.model,DAY)];
  const gate=shippedReleaseGate(required,advisory,reports,true);
  assert.equal(gate.passed,true);
  assert.deepEqual(gate.advisoryWarnings,advisory.map(m=>`${m.provider}/${m.model}`));
  assert.deepEqual(gate.advisory.map(m=>m.label),['unknown','unknown','unknown']);
  // A genuine fresh advisory recording clears its warning; a stale one in release mode keeps the warning but still does not block.
  const first=advisory[0]!;
  assert.equal(shippedReleaseGate(required,advisory,[...reports,gateReport(first.provider,first.model,DAY)],true).advisoryWarnings.length,2);
  const stale=shippedReleaseGate(required,advisory,[...reports,gateReport(first.provider,first.model,30*DAY)],true);
  assert.equal(stale.passed,true); assert.equal(stale.advisoryWarnings.length,3);
  // Once confirmed (one-line approval change) the same candidate is mandatory and its absence blocks.
  assert.equal(shippedReleaseGate([...required,first],advisory.slice(1),reports,true).passed,false);
});
