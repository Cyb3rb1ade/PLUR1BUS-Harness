import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shippedModels, setupDefault, pendingShippedModels } from '../../../../config/shipped-models.ts';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('setup only preselects owner-confirmed pins actually discovered for that provider', () => {
  assert.deepEqual(shippedModels.map(m=>m.provider), ['anthropic','openai','google','ollama']);
  const available=shippedModels.map(m=>({provider:m.provider,id:m.model}));
  assert.equal(setupDefault('anthropic',available),'anthropic/claude-sonnet-5-5');
  assert.equal(setupDefault('anthropic',[]),'');
  for(const provider of ['openai','google','ollama','xai','openrouter','custom']) assert.equal(setupDefault(provider,available),'');
  assert.equal(pendingShippedModels().length,3);
});
test('recorded CI release gate uses exactly the shipped inventory and refuses missing recordings', async () => {
  const dir=await mkdtemp(join(tmpdir(),'d106-release-'));
  try {
    await assert.rejects(promisify(execFile)(process.execPath,['--experimental-strip-types','--conditions=source','--no-warnings=ExperimentalWarning',fileURLToPath(new URL('../../../../scripts/eval/tool-eval-host.ts',import.meta.url)),'--recorded','--require-release'],{env:{...process.env,PLUR1BUS_HOST_EVAL_OUT:dir,PLUR1BUS_HOST_EVAL_MODELS:'[]'}}),e=>!!e && typeof e==='object' && 'code' in e && e.code===1);
    const gate=JSON.parse(await readFile(join(dir,'gate.json'),'utf8'));
    assert.equal(gate.passed,false);
    assert.deepEqual(gate.models.map((m:{provider:string;model:string})=>({provider:m.provider,model:m.model})),shippedModels.map(({provider,model})=>({provider,model})));
    assert.deepEqual(gate.pendingOwnerOrDiscovery,pendingShippedModels());
    const ci=await readFile(new URL('../../../../.github/workflows/ci.yml',import.meta.url),'utf8');
    assert.match(ci,/tool-eval-host.ts --recorded --require-release/);
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
