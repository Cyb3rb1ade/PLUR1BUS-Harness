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

import { summarizeLatencyPhases } from '../spikes/decision-laya-lib.mjs';
test('process-first inference is separated from warm calls without discarding either sample set',()=>{
  const rows=[900,10,20,30];
  const phases=summarizeLatencyPhases(rows);
  assert.deepEqual(phases,{firstInferenceMs:900,warmLatency:{n:3,p50:20,p95:30}});
  assert.deepEqual(rows,[900,10,20,30]);
  assert.deepEqual(summarizeLatencyPhases([12]),{firstInferenceMs:12,warmLatency:{n:0,p50:null,p95:null}});
  assert.deepEqual(summarizeLatencyPhases([]),{firstInferenceMs:null,warmLatency:{n:0,p50:null,p95:null}});
  assert.throws(()=>summarizeLatencyPhases([1,NaN]),/latency/);
  assert.throws(()=>summarizeLatencyPhases([-1]),/latency/);
});

import { specialTokenNames, buildCappedInputs, expectedCalibrationError, parseProcStat, foreignCpuShare } from '../spikes/decision-laya-candidates.mjs';
import { buildInputs as buildUncapped } from '../spikes/decision-laya-lib.mjs';
const charTok = { encode: text => Array.from(text, c => c.charCodeAt(0)), cls: 1, sep: 2, mask: 3 };
const cappedRequest = { primitive: 'choice', question: 'pick', state: 'state-with-a-long-tail-0123456789', options: [{ id: 'a', description: 'x' }, { id: 'b', description: 'y' }] };

test('candidate runner reads special tokens from the tokenizer config and falls back to the English BERT trio', () => {
  assert.deepEqual(specialTokenNames({ cls_token: '<bos>', sep_token: '<eos>', mask_token: '<mask>' }), { cls: '<bos>', sep: '<eos>', mask: '<mask>' });
  assert.deepEqual(specialTokenNames({ cls_token: { content: '<c>' } }), { cls: '<c>', sep: '[SEP]', mask: '[MASK]' });
  assert.deepEqual(specialTokenNames({}), { cls: '[CLS]', sep: '[SEP]', mask: '[MASK]' });
  assert.deepEqual(specialTokenNames(undefined), { cls: '[CLS]', sep: '[SEP]', mask: '[MASK]' });
});
test('without a token cap the candidate prompt is byte-identical to the hash-pinned runner prompt', () => {
  const config = { max_len: 200, head_max_len: 100 };
  const base = buildUncapped(cappedRequest, charTok, config), same = buildCappedInputs(cappedRequest, charTok, config);
  assert.deepEqual({ ids: same.ids, positions: same.positions }, base);
  assert.equal(same.truncated, false);
  // A cap that is not reached changes nothing either.
  const roomy = buildCappedInputs(cappedRequest, charTok, config, 150);
  assert.deepEqual(roomy.ids, base.ids); assert.equal(roomy.truncated, false); assert.equal(roomy.stateTokensUsed, roomy.stateTokens);
});
test('token cap keeps the whole head, clips the state on the right and always ends with a separator', () => {
  const config = { max_len: 200, head_max_len: 100 };
  const full = buildUncapped(cappedRequest, charTok, config);
  const head = full.ids.length - cappedRequest.state.length - 1; // head (already ends in [SEP]); the state and its closing [SEP] follow
  const capped = buildCappedInputs(cappedRequest, charTok, config, head + 10 + 1);
  assert.equal(capped.ids.length, head + 10 + 1);
  assert.deepEqual(capped.ids.slice(0, head), full.ids.slice(0, head));
  assert.deepEqual(capped.positions, full.positions);
  assert.equal(capped.ids.at(-1), 2);
  assert.deepEqual(capped.ids.slice(head, head + 10), charTok.encode(cappedRequest.state).slice(0, 10)); // right clip: the beginning survives
  assert.equal(capped.stateTokensUsed, 10); assert.equal(capped.stateTokens, cappedRequest.state.length); assert.equal(capped.truncated, true);
  // No room at all: head + closing separator only.
  const bare = buildCappedInputs(cappedRequest, charTok, config, head + 1);
  assert.equal(bare.stateTokensUsed, 0); assert.deepEqual(bare.ids, [...full.ids.slice(0, head), 2]);
});
test('a head longer than the token cap is refused, never shortened; invalid caps are refused', () => {
  const config = { max_len: 200, head_max_len: 100 };
  assert.throws(() => buildCappedInputs(cappedRequest, charTok, config, 20), /head exceeds token cap/);
  assert.throws(() => buildCappedInputs(cappedRequest, charTok, config, 7), /invalid max tokens/);
  assert.throws(() => buildCappedInputs(cappedRequest, charTok, config, 12.5), /invalid max tokens/);
  assert.throws(() => buildCappedInputs({ ...cappedRequest, options: [cappedRequest.options[0]] }, charTok, config, 100), /invalid request/);
});
test('ECE uses 15 equal-width bins on the top probability and matches hand-computed values', () => {
  const rows = [['a', .9], ['a', .9], ['a', .9], ['b', .9]].map(([gold, p]) => ({ gold: gold === 'a' ? 'a' : 'b', probabilities: { a: p, b: 1 - p } }));
  // top class is always "a" (p=.9): three correct, one wrong -> one bin, |0.9 - 0.75|
  assert.ok(Math.abs(expectedCalibrationError(rows) - .15) < 1e-12);
  const split = [{ gold: 'a', probabilities: { a: .6, b: .4 } }, { gold: 'b', probabilities: { a: .95, b: .05 } }];
  assert.ok(Math.abs(expectedCalibrationError(split) - (.5 * .4 + .5 * .95)) < 1e-12);
  assert.equal(expectedCalibrationError([]), null);
  assert.throws(() => expectedCalibrationError(rows, 0), /bins/);
});
test('contention evidence: /proc/stat parsing and the foreign CPU share exclude this process own CPU time', () => {
  const text = 'cpu  100 5 50 800 20 1 2 3 0 0\ncpu0 1 1 1 1 1 1 1 1 0 0\n';
  assert.deepEqual(parseProcStat(text), { busy: 100 + 5 + 50 + 1 + 2, idle: 820, steal: 3 });
  assert.throws(() => parseProcStat('intr 1 2 3'), /no cpu line/);
  const before = { busy: 1000, idle: 0, steal: 0 }, after = { busy: 1200, idle: 0, steal: 0 }; // 200 jiffies = 2000 ms busy
  assert.ok(Math.abs(foreignCpuShare(before, after, 1900, 1000, 2) - 100 / 2000) < 1e-12); // 100 ms foreign over 2 cpus x 1 s
  assert.equal(foreignCpuShare(before, after, 5000, 1000, 2), 0); // never negative
  assert.equal(foreignCpuShare(before, after, 0, 0, 2), null);
});

import { readFileSync } from 'node:fs';
const evidence = name => JSON.parse(readFileSync(new URL(`../../docs/evidence/decision/${name}`, import.meta.url), 'utf8'));
test('Linux candidate comparison evidence is complete, quiet-machine validated and consistent with the committed receipts', () => {
  const comparison = evidence('2026-10-21-linux-x64-candidates.json');
  assert.equal(comparison.schema, 'plur1bus.decision-candidates-comparison/1');
  assert.ok(comparison.honesty.some(line => /agent-authored/.test(line)) && comparison.honesty.some(line => /not reference hardware/.test(line)));
  const fixtureHash = createHash('sha256').update(readFileSync(new URL('../spikes/decision-eval-cases.json', import.meta.url))).digest('hex');
  const names = new Set(comparison.runs.map(run => run.run));
  assert.equal(names.size, comparison.runs.length);
  for (const required of ['A-orig-t1', 'A-orig-t2', 'A-t1', 'A-t2', 'B-t1', 'B-t2', 'C-t1', 'C-t2', 'D-t2', 'A-t2-cap128', 'A-t2-cap256', 'B-t2-cap128', 'B-t2-cap256', 'C-t2-cap128', 'C-t2-cap256', 'D-t2-cap128', 'D-t2-cap256'])
    assert.ok(names.has(required), `missing run ${required}`);
  for (const run of comparison.runs) {
    assert.equal(run.warmLatencyMs.n, 179); assert.ok(run.warmLatencyMs.p50 > 0 && run.warmLatencyMs.p95 >= run.warmLatencyMs.p50, run.run);
    assert.equal(run.accuracy.n, 60); assert.equal(run.errorRows, 0);
    assert.equal(run.accuracy.de, run.accuracy.deCorrect / 60); assert.equal(run.accuracy.en, run.accuracy.enCorrect / 60);
    assert.ok(run.contention.foreignCpuShareInferenceLoop < 0.05 && run.contention.worstChunkOf30Calls < 0.10 && run.contention.stealShare < 0.05, `${run.run} overlapped foreign load`);
    assert.ok(Number(run.contention.loadAvgAtStart.split(' ')[0]) < 0.5, `${run.run} did not start on a quiet machine`);
    assert.equal(run.germanGate.passed, false, 'no candidate may be reported as passing the preliminary German gate on this evidence');
    if (run.maxTokens !== null) assert.ok(run.threads === 2);
  }
  // Candidate A rows must agree with the committed hash-pinned receipts (same runner family, same model).
  for (const [run, receipt] of [['A-orig-t1', 'laya-linux-x64-threads1.json'], ['A-orig-t2', 'laya-linux-x64-threads2.json']]) {
    const entry = comparison.runs.find(r => r.run === run), proof = evidence(receipt);
    assert.equal(proof.fixtureSha256, fixtureHash);
    assert.equal(entry.warmLatencyMs.p50, proof.warmLatency.p50); assert.equal(entry.warmLatencyMs.p95, proof.warmLatency.p95);
    assert.equal(entry.accuracy.deCorrect, 28); assert.equal(entry.accuracy.enCorrect, 39);
  }
  // Caps that exceed every sequence are no-ops: identical answers, nothing truncated.
  for (const run of comparison.runs.filter(r => r.maxTokens !== null && r.maxTokens >= 128)) {
    assert.equal(run.sequenceTokens.truncatedRows, 0, run.run);
    assert.equal(run.optionAgreementWithReference.fraction, 1, run.run);
  }
  assert.equal(comparison.runs.find(r => r.run === 'B-t2-cap64').sequenceTokens.truncatedRows, 36);
});

test('NAS VM candidate evidence: swap-free, quiet, hashes recorded, int8 failure on record, consistent with the cloud picks', () => {
  const nas = evidence('2026-10-21-nas-ubuntu-candidates.json'), cloud = evidence('2026-10-21-linux-x64-candidates.json');
  assert.equal(nas.schema, 'plur1bus.decision-candidates-comparison/1');
  assert.equal(nas.hostRole, 'owner-nas-vm');
  assert.ok(nas.honesty.some(line => /agent-authored/.test(line)) && nas.honesty.some(line => /not reference hardware/.test(line)));
  const names = new Set(nas.runs.map(run => run.run));
  assert.equal(names.size, nas.runs.length);
  for (const candidate of ['A', 'B', 'C', 'D']) for (const threads of [1, 2, 4, 8]) assert.ok(names.has(`${candidate}-t${threads}`), `missing ${candidate}-t${threads}`);
  const fixtureHash = createHash('sha256').update(readFileSync(new URL('../spikes/decision-eval-cases.json', import.meta.url))).digest('hex');
  for (const candidate of ['A', 'B', 'C', 'D']) assert.ok(nas.candidates[candidate].artifacts.every(a => /^[a-f0-9]{64}$/.test(a.sha256) && a.size > 0), `${candidate} artifacts`);
  for (const run of nas.runs) {
    assert.equal(run.warmLatencyMs.n, 179); assert.ok(run.warmLatencyMs.p50 > 0 && run.warmLatencyMs.p95 >= run.warmLatencyMs.p50, run.run);
    assert.equal(run.accuracy.n, 60); assert.equal(run.errorRows, 0);
    assert.equal(run.accuracy.de, run.accuracy.deCorrect / 60); assert.equal(run.accuracy.en, run.accuracy.enCorrect / 60);
    assert.equal(run.swap.siKiB, 0, `${run.run} swapped in`); assert.equal(run.swap.soKiB, 0, `${run.run} swapped out`); assert.equal(run.swap.secondsWithSwapActivity, 0);
    assert.ok(run.swap.vmstatSamples > 10);
    assert.ok(run.contention.loadAvg1minBeforeLaunch < 0.5, `${run.run} did not start on a quiet machine`);
    assert.ok(run.contention.foreignCpuShareInferenceLoop < 0.05 && run.contention.worstChunkOf30Calls < 0.10 && run.contention.stealShare < 0.05, `${run.run} overlapped foreign load`);
    // The relative gate can only be 'passed' by a model that is at chance level in both languages (D); that must be flagged as trivial.
    if (run.germanGate.passed) { assert.ok(run.germanGate.trivial && run.accuracy.en < 0.4 && run.accuracy.de < 0.4, `${run.run} passes the gate without being trivially at chance`); }
    assert.match(run.vmConfig, /^cfg[12]-/);
  }
  // A and B must reproduce the picks (hence the metrics) of the cloud runs; the NAS never produces a different answer for fp models.
  const cloudRun = name => cloud.runs.find(run => run.run === name);
  for (const [nasRun, cloudName] of [['A-t1', 'A-t1'], ['A-t2', 'A-t2'], ['B-t1', 'B-t1'], ['B-t2', 'B-t2']]) {
    const a = nas.runs.find(run => run.run === nasRun), b = cloudRun(cloudName);
    assert.equal(a.accuracy.deCorrect, b.accuracy.deCorrect, nasRun); assert.equal(a.accuracy.enCorrect, b.accuracy.enCorrect, nasRun);
    assert.ok(Math.abs(a.brier.de - b.brier.de) < 1e-4 && Math.abs(a.brier.en - b.brier.en) < 1e-4, nasRun);
  }
  // The int8 failure on this CPU stays on the record and nobody may call C or D usable.
  for (const name of ['C-t2', 'D-t2']) assert.ok(nas.runs.find(run => run.run === name).accuracy.en < 0.4, `${name} int8 failure not recorded`);
  assert.match(nas.candidates.C.status, /broken/); assert.match(nas.candidates.D.status, /broken/);
  assert.ok(nas.runs.every(run => run.optionAgreementWithReference === null || run.optionAgreementWithReference.fraction <= 1));
  assert.equal(nas.method.discardedRuns.every(d => d.vmstatSiKiB > 0 || d.vmstatSoKiB > 0), true);
  assert.ok(fixtureHash.length === 64);
});
