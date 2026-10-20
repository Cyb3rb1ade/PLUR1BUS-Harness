import { test } from 'node:test';
import assert from 'node:assert/strict';
import { softmax, temperatureFor, buildInputs, evaluate, germanGate } from '../spikes/decision-laya-lib.mjs';

test('softmax remains finite for large logits and rejects invalid temperatures', () => {
  assert.deepEqual(softmax([10000,10000], 2), [.5,.5]);
  assert.throws(() => softmax([1,2], 0));
  assert.throws(() => softmax([1,NaN], 1));
});
test('temperature fallback follows the primitive index, including score and noul', () => {
  const c = { temperature: [2,3,4], temperature_by_options: { 'choice:2': 5 } };
  assert.equal(temperatureFor(c,'choice',2),5);
  assert.equal(temperatureFor(c,'score',2),3);
  assert.equal(temperatureFor(c,'noul',2),4);
});
test('prompt construction preserves all options and refuses oversized head/state rather than losing evidence', () => {
  const tokenize = text => Array.from(text, c => c.charCodeAt(0));
  const tok = { encode: tokenize, cls: 1, sep: 2, mask: 3 };
  const req = { primitive: 'choice', question: 'pick', state: 'state', options: [{id:'a',description:'x'}, {id:'b',description:'y'}] };
  const result = buildInputs(req, tok, { max_len: 100, head_max_len: 80 });
  assert.equal(result.positions.length,2);
  assert.equal(result.ids[result.positions[0]],3);
  assert.equal(result.ids.at(-1),2);
  assert.throws(() => buildInputs(req,tok,{max_len:100,head_max_len:10}), /head/);
  assert.throws(() => buildInputs({...req,state:'z'.repeat(100)},tok,{max_len:80,head_max_len:80}), /state/);
});
test('accuracy and multiclass Brier include errors with independently calculated values', () => {
  const rows = [{ gold:'a', probabilities:{a:.8,b:.2} }, { gold:'b', probabilities:{a:.6,b:.4} }];
  const m = evaluate(rows);
  assert.equal(m.accuracy,.5);
  assert.ok(Math.abs(m.brier-.4)<1e-12); // (.04+.04+.36+.36)/2
  assert.throws(() => evaluate([{gold:'missing', probabilities:{a:1}}]));
  assert.throws(() => evaluate([{gold:'a', probabilities:{a:.8,b:.8}}]));
});
test('German gate needs all sixty paired cases, both metrics and verified model/platform evidence', () => {
  const metrics = { n:60, accuracy:.8, brier:.2 };
  assert.equal(germanGate({de:metrics,en:metrics,paired:60,verified:true}).passed,true);
  assert.equal(germanGate({de:{...metrics,accuracy:.749},en:metrics,paired:60,verified:true}).passed,false);
  assert.equal(germanGate({de:{...metrics,brier:.251},en:metrics,paired:60,verified:true}).passed,false);
  assert.equal(germanGate({de:metrics,en:metrics,paired:59,verified:true}).passed,false);
  assert.equal(germanGate({de:metrics,en:metrics,paired:60,verified:false}).passed,false);
});

import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyArtifacts } from '../spikes/decision-laya.mjs';
import { prepareLaya } from '../spikes/decision-laya-prepare.mjs';

test('download uses the supplied HostFetch and rejects digest mismatch without promoting partial artifacts', async () => {
  const dir=await mkdtemp(join(tmpdir(),'gp4-laya-'));
  const bytes=Buffer.from('model');const sha=createHash('sha256').update(bytes).digest('hex');
  const manifest={repository:'inferenceprince/laya-onnx',revision:'d'.repeat(40),files:[{file:'model.onnx',size:5,sha256:sha}]};
  try{
    await assert.rejects(prepareLaya({directory:dir,manifest,hostFetch:async()=>new Response('wrong')}),/digest/);
    await assert.rejects(readFile(join(dir,'model.onnx')),{code:'ENOENT'});
    let url;
    await prepareLaya({directory:dir,manifest,hostFetch:async u=>{url=u;return new Response(bytes);}});
    assert.equal(url,`https://huggingface.co/inferenceprince/laya-onnx/resolve/${'d'.repeat(40)}/model.onnx`);
    assert.deepEqual(await readFile(join(dir,'model.onnx')),bytes);
    await verifyArtifacts(dir,manifest);
    await writeFile(join(dir,'model.onnx'),'other');
    await assert.rejects(verifyArtifacts(dir,manifest),/digest/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('download rejects oversize response and abort; no native fetch fallback exists', async () => {
  const dir=await mkdtemp(join(tmpdir(),'gp4-laya-'));
  const manifest={repository:'inferenceprince/laya-onnx',revision:'a'.repeat(40),files:[{file:'model.onnx',size:1,sha256:'0'.repeat(64)}]};
  try{
    await assert.rejects(prepareLaya({directory:dir,manifest,hostFetch:async()=>new Response('too long')}),/size/);
    await assert.rejects(prepareLaya({directory:dir,manifest,hostFetch:undefined}),/HostFetch/);
    await assert.rejects(prepareLaya({directory:dir,manifest,signal:AbortSignal.abort(),hostFetch:async()=>new Response('x')}));
  }finally{await rm(dir,{recursive:true,force:true});}
});

import { validateCases } from '../spikes/decision-laya-lib.mjs';
test('evaluation rejects duplicate case IDs and missing translations before a gate can be computed', () => {
  const row={id:'one',coreGate:true,primitive:'choice',gold:'a',question:{de:'Frage',en:'Question'},state:{de:'Text',en:'Text'},options:[{id:'a',description:{de:'A',en:'A'}},{id:'b',description:{de:'B',en:'B'}}]};
  assert.throws(()=>validateCases([row,row]),/duplicate/);
  assert.throws(()=>validateCases([{...row,state:{en:'Only English'}}]),/translation/);
  assert.throws(()=>validateCases([{...row,gold:'missing'}]),/gold/);
});

import { mkdir, symlink } from 'node:fs/promises';
test('catalog preparation and cache verification reject parent and final symlinks', async () => {
  const base=await mkdtemp(join(tmpdir(),'gp4-laya-symlink-')),cache=join(base,'cache'),outside=join(base,'outside');
  await mkdir(cache);await mkdir(outside);
  const data=Buffer.from('model'),sha=createHash('sha256').update(data).digest('hex');
  const manifest={repository:'inferenceprince/laya-onnx',revision:'d'.repeat(40),files:[{file:'tokenizer/tokenizer.json',size:5,sha256:sha}]};
  try{
    await symlink(outside,join(cache,'tokenizer'),'dir');
    await assert.rejects(prepareLaya({directory:cache,manifest,hostFetch:async()=>new Response(data)}),/symlink/);
    await assert.rejects(readFile(join(outside,'tokenizer.json')),{code:'ENOENT'});
    await rm(join(cache,'tokenizer'));await mkdir(join(cache,'tokenizer'));await writeFile(join(outside,'valid.json'),data);
    await symlink(join(outside,'valid.json'),join(cache,'tokenizer','tokenizer.json'),'file');
    await assert.rejects(verifyArtifacts(cache,manifest),/symlink/);
    await assert.rejects(prepareLaya({directory:cache,manifest,hostFetch:async()=>new Response(data)}),/symlink/);
  }finally{await rm(base,{recursive:true,force:true});}
});
