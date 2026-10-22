#!/usr/bin/env node
// Explicit offline candidate runner for the Laya decision spike (Linux x64 comparison, 2026-10-21).
//
// It measures any Laya-style ONNX decision graph (inputs input_ids, attention_mask, marker_pos,
// marker_mask, qtype; output logits) on the SAME fixture, with the SAME warm-up/statistics method as
// `decision-laya.mjs`: one fresh process, one request per call, first call reported separately, warm
// p50/p95 over the remaining 179 calls, a ten-call five-question batch. It does not replace that
// runner: the hash-pinned receipts (`laya-*.json`) are still produced by `decision-laya.mjs`, whose
// bytes (and the `sourceSha256` pins that cover them) are untouched.
//
// Differences from `decision-laya.mjs`, all opt-in or additive:
//   * the model directory is not required to match the English manifest; every file is hashed and the
//     hashes are recorded (`--manifest` additionally verifies them against a manifest);
//   * special tokens come from the tokenizer config (`<bos>/<eos>/<mask>` for mmBERT, `[CLS]/[SEP]/[MASK]`
//     for the English root), nothing else about the prompt layout changes;
//   * `--max-tokens N` caps the sequence the way Laya itself does (`laya.common.build_sequence`): the head
//     (question + options) is never cut, the state is clipped on the right to the room that is left, and a
//     head that alone exceeds the cap is reported as an error row, never silently shortened;
//   * ECE (15 equal-width bins on the top probability, Laya's `ece_score`) and CPU-contention evidence
//     (`/proc/loadavg`, foreign CPU share from `/proc/stat` against this process' own CPU time) are added.
// Runtime dependencies come from an existing installation (`--runtime-package`), exactly as there.
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { readFileSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve, relative, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { cpus, platform, arch, release, totalmem, freemem } from 'node:os';
import { softmax, temperatureFor, buildInputs, evaluate, germanGate, percentile, validateCases, summarizeLatencyPhases } from './decision-laya-lib.mjs';
import { verifyArtifacts } from './decision-laya.mjs';

/** Special-token names from a tokenizer_config.json; the English root has none and uses the BERT trio. */
export function specialTokenNames(tokenizerConfig) {
  const pick = (key, fallback) => {
    const value = tokenizerConfig?.[key];
    const text = typeof value === 'string' ? value : value?.content;
    return typeof text === 'string' && text ? text : fallback;
  };
  return { cls: pick('cls_token', '[CLS]'), sep: pick('sep_token', '[SEP]'), mask: pick('mask_token', '[MASK]') };
}

/**
 * Same prompt as `buildInputs`, plus an optional total-token cap with Laya's truncation rule.
 * Without `maxTokens` the result is `buildInputs`' result (checked by a test). With it, the head is kept whole,
 * the state is clipped on the right to `maxTokens - head - 1` tokens and a final separator is appended.
 * A head longer than the cap throws: dropping option markers would silently change the question.
 */
export function buildCappedInputs(request, tokenizer, config, maxTokens) {
  if (maxTokens === undefined || maxTokens === null) {
    const built = buildInputs(request, tokenizer, config);
    return { ...built, stateTokens: null, stateTokensUsed: null, truncated: false };
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 8) throw Error('invalid max tokens');
  // Empty state: buildInputs validates the request and the head budget; its last token is the separator
  // that would close an empty state, which is dropped here and re-added after the (clipped) state.
  const head = buildInputs({ ...request, state: '' }, tokenizer, config);
  const headIds = head.ids.slice(0, -1);
  if (headIds.length + 1 > maxTokens) throw Error('head exceeds token cap');
  const stateIds = tokenizer.encode(request.state);
  const effectiveMax = Math.min(maxTokens, config.max_len ?? maxTokens);
  const room = Math.max(0, effectiveMax - headIds.length - 1);
  const used = stateIds.slice(0, room);
  const ids = [...headIds, ...used, tokenizer.sep];
  if (ids.some(v => !Number.isSafeInteger(v) || v < 0)) throw Error('invalid token id');
  return { ids, positions: head.positions, stateTokens: stateIds.length, stateTokensUsed: used.length, truncated: used.length < stateIds.length };
}

/** Laya's `ece_score`: equal-width bins, first bin closed on the left, weighted |mean confidence - accuracy|. */
export function expectedCalibrationError(rows, bins = 15) {
  if (!Number.isSafeInteger(bins) || bins < 1) throw Error('invalid bins');
  if (!rows.length) return null;
  const points = rows.map(({ gold, probabilities }) => {
    const [best, confidence] = Object.entries(probabilities).reduce((a, b) => (a[1] >= b[1] ? a : b));
    return { confidence, correct: best === gold ? 1 : 0 };
  });
  let ece = 0;
  for (let i = 0; i < bins; i++) {
    const lo = i / bins, hi = (i + 1) / bins;
    const selected = points.filter(p => (i === 0 ? p.confidence >= lo : p.confidence > lo) && p.confidence <= hi);
    if (!selected.length) continue;
    const mean = key => selected.reduce((s, p) => s + p[key], 0) / selected.length;
    ece += (selected.length / points.length) * Math.abs(mean('confidence') - mean('correct'));
  }
  return ece;
}

/** Parse the aggregate `cpu ` line of /proc/stat (jiffies). Pure so it can be tested. */
export function parseProcStat(text) {
  const line = text.split('\n').find(l => l.startsWith('cpu '));
  if (!line) throw Error('no cpu line');
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = line.trim().split(/\s+/).slice(1).map(Number);
  if (![user, nice, system, idle].every(Number.isFinite)) throw Error('invalid cpu line');
  return { busy: user + nice + system + irq + softirq, idle: idle + iowait, steal };
}
/**
 * Share of the machine that something other than this process used between two snapshots:
 * (system busy time - this process' own CPU time) / (wall time x logical CPUs). USER_HZ is 100 on Linux.
 */
export function foreignCpuShare(before, after, ownCpuMs, wallMs, logicalCpus) {
  if (!(wallMs > 0) || !(logicalCpus > 0)) return null;
  const busyMs = (after.busy - before.busy) * 10;
  return Math.max(0, (busyMs - ownCpuMs) / (wallMs * logicalCpus));
}
function snapshot() {
  try {
    const usage = process.cpuUsage();
    return { stat: parseProcStat(readFileSync('/proc/stat', 'utf8')), ownCpuMs: (usage.user + usage.system) / 1000, at: performance.now() };
  } catch { return null; }
}
function contention(before, after, logicalCpus) {
  if (!before || !after) return null;
  return {
    foreignCpuShare: foreignCpuShare(before.stat, after.stat, after.ownCpuMs - before.ownCpuMs, after.at - before.at, logicalCpus),
    stealShare: (after.stat.steal - before.stat.steal) * 10 / ((after.at - before.at) * logicalCpus),
    wallMs: after.at - before.at,
  };
}
const loadAverage = () => { try { return readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/).slice(0, 3).map(Number); } catch { return null; } };

async function hashTree(directory) {
  const out = [];
  const walk = async dir => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(path)) hash.update(chunk);
        out.push({ file: relative(directory, path).split('\\').join('/'), size: (await stat(path)).size, sha256: hash.digest('hex') });
      }
    }
  };
  await walk(directory);
  return out;
}

export async function loadCandidate({ directory, runtimePackage, threads = 1 }) {
  const require = createRequire(resolve(runtimePackage));
  const ort = await import(pathToFileURL(require.resolve('onnxruntime-node')).href);
  const { PreTrainedTokenizer, env } = await import(pathToFileURL(require.resolve('@huggingface/transformers')).href);
  env.allowRemoteModels = false;
  const json = async file => JSON.parse(await readFile(join(directory, file), 'utf8'));
  const tokenizerConfig = await json('tokenizer/tokenizer_config.json');
  const tokenizer = new PreTrainedTokenizer(await json('tokenizer/tokenizer.json'), tokenizerConfig);
  const raw = tokenizer._tokenizer, names = specialTokenNames(tokenizerConfig);
  const tok = { encode: text => tokenizer.encode(text, { add_special_tokens: false }), cls: raw.token_to_id(names.cls), sep: raw.token_to_id(names.sep), mask: raw.token_to_id(names.mask) };
  if (![tok.cls, tok.sep, tok.mask].every(Number.isSafeInteger)) throw Error('special tokens missing from tokenizer');
  const config = await json('rl_agent_config.json');
  const session = await ort.InferenceSession.create(join(directory, 'model.onnx'), { executionProviders: ['cpu'], intraOpNumThreads: threads, interOpNumThreads: 1 });
  const tensor = (type, data, dims) => new ort.Tensor(type, data, dims);
  return {
    specialTokens: { ...names, ids: { cls: tok.cls, sep: tok.sep, mask: tok.mask } },
    encode: tok.encode,
    async run(requests, maxTokens) {
      const inputs = requests.map(req => buildCappedInputs(req, tok, config, maxTokens));
      const n = inputs.length, seq = Math.max(...inputs.map(r => r.ids.length)), options = Math.max(...inputs.map(r => r.positions.length));
      const ids = new BigInt64Array(n * seq), mask = new BigInt64Array(n * seq), positions = new BigInt64Array(n * options), markerMask = new Uint8Array(n * options), types = new BigInt64Array(n);
      for (let i = 0; i < n; i++) {
        inputs[i].ids.forEach((v, j) => { ids[i * seq + j] = BigInt(v); mask[i * seq + j] = 1n; });
        inputs[i].positions.forEach((v, j) => { positions[i * options + j] = BigInt(v); markerMask[i * options + j] = 1; });
        types[i] = BigInt({ choice: 0, score: 1, noul: 2 }[requests[i].primitive]);
      }
      const output = await session.run({ input_ids: tensor('int64', ids, [n, seq]), attention_mask: tensor('int64', mask, [n, seq]), marker_pos: tensor('int64', positions, [n, options]), marker_mask: tensor('bool', markerMask, [n, options]), qtype: tensor('int64', types, [n]) });
      return requests.map((req, i) => {
        const count = req.options.length, logits = Array.from(output.logits.data.slice(i * options, i * options + count));
        const p = softmax(logits, temperatureFor(config, req.primitive, count));
        const confidence = 1 + p.reduce((s, v) => s + (v === 0 ? 0 : v * Math.log(v)), 0) / Math.log(count);
        return { probabilities: Object.fromEntries(req.options.map((o, j) => [o.id, p[j]])), confidence, confidenceSource: 'derived', tokens: inputs[i].ids.length, stateTokens: inputs[i].stateTokens, stateTokensUsed: inputs[i].stateTokensUsed, truncated: inputs[i].truncated };
      });
    },
    async close() { await session.release(); },
  };
}

function cpuInfo() {
  const out = { model: cpus()[0]?.model, logicalCpus: cpus().length, flags: null };
  try {
    const text = readFileSync('/proc/cpuinfo', 'utf8');
    const flags = new Set((text.match(/^flags\s*:\s*(.*)$/m)?.[1] ?? '').split(/\s+/));
    out.flags = Object.fromEntries(['sse4_2', 'avx', 'avx2', 'fma', 'f16c', 'avx512f', 'avx512bw', 'avx512vl', 'avx512_vnni', 'avx_vnni', 'avx512_bf16', 'avx512_fp16', 'amx_tile', 'amx_int8', 'amx_bf16'].map(f => [f, flags.has(f)]));
    out.allAvxFlags = [...flags].filter(f => /^(avx|amx|fma|f16c)/.test(f)).sort();
    out.hypervisor = flags.has('hypervisor');
  } catch { /* not Linux */ }
  return out;
}
/** Version of an installed package: walk up from its resolved entry (package.json is not always exported). */
const packageVersion = (require, name) => {
  try {
    let dir = dirname(require.resolve(name));
    for (let i = 0; i < 6; i++, dir = dirname(dir)) {
      try { const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); if (pkg.name === name) return pkg.version; } catch { /* keep walking */ }
    }
  } catch { /* not installed */ }
  return null;
};

async function main() {
  const args = process.argv.slice(2), options = {};
  const usage = 'usage: --model-dir PATH --runtime-package package.json --out PATH --label NAME [--threads N] [--max-tokens N] [--manifest PATH] [--source JSON]';
  for (let i = 0; i < args.length; i += 2) { if (!args[i].startsWith('--') || args[i + 1] === undefined) throw Error(usage); options[args[i].slice(2)] = args[i + 1]; }
  if (!options['model-dir'] || !options['runtime-package'] || !options.out || !options.label) throw Error(usage);
  const fixtureUrl = new URL('./decision-eval-cases.json', import.meta.url);
  const fixtureBytes = await readFile(fixtureUrl), fixture = JSON.parse(fixtureBytes);
  validateCases(fixture.cases);
  const threads = Number(options.threads ?? 1); if (!Number.isSafeInteger(threads) || threads < 1 || threads > 16) throw Error('invalid threads');
  const maxTokens = options['max-tokens'] === undefined ? undefined : Number(options['max-tokens']);
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 8)) throw Error('invalid max-tokens');
  const manifest = options.manifest ? JSON.parse(await readFile(options.manifest, 'utf8')) : null;
  if (manifest) await verifyArtifacts(options['model-dir'], manifest);
  const artifacts = await hashTree(options['model-dir']);
  const logicalCpus = cpus().length, loadStart = loadAverage(), freeMemoryBeforeBytes = freemem();
  const wholeStart = snapshot();
  const started = performance.now();
  const model = await loadCandidate({ directory: options['model-dir'], runtimePackage: options['runtime-package'], threads });
  const loadMs = performance.now() - started, rows = [], latencies = [], chunks = [];
  try {
    const loopStart = snapshot();
    let chunkStart = loopStart, calls = 0;
    for (const row of fixture.cases) for (const locale of ['de', 'en']) {
      const request = { primitive: row.primitive, question: row.question[locale], state: row.state[locale], options: row.options.map(o => ({ id: o.id, description: o.description[locale] })) };
      const before = performance.now();
      try {
        const [answer] = await model.run([request], maxTokens);
        const elapsedMs = performance.now() - before; latencies.push(elapsedMs);
        rows.push({ id: row.id, useCase: row.useCase, coreGate: row.coreGate, locale, gold: row.gold, ...answer, elapsedMs });
      } catch (error) {
        rows.push({ id: row.id, useCase: row.useCase, coreGate: row.coreGate, locale, gold: row.gold, error: String(error.message).includes('cap') ? 'head-exceeds-cap' : 'inference-failed' });
      }
      if (++calls % 30 === 0) { const now = snapshot(); chunks.push(contention(chunkStart, now, logicalCpus)?.foreignCpuShare ?? null); chunkStart = now; }
    }
    const loopContention = contention(loopStart, snapshot(), logicalCpus);
    const core = locale => rows.filter(r => r.coreGate && r.locale === locale);
    const complete = ['de', 'en'].every(l => core(l).length === 60 && core(l).every(r => !r.error));
    const de = complete ? { ...evaluate(core('de')), ece: expectedCalibrationError(core('de')) } : null;
    const en = complete ? { ...evaluate(core('en')), ece: expectedCalibrationError(core('en')) } : null;
    const perUseCase = {};
    for (const useCase of new Set(rows.map(r => r.useCase))) for (const locale of ['de', 'en']) {
      const selected = rows.filter(r => r.useCase === useCase && r.locale === locale);
      perUseCase[`${useCase}:${locale}`] = selected.every(r => !r.error) ? evaluate(selected) : { n: selected.length, errors: selected.filter(r => r.error).length };
    }
    const five = fixture.cases.slice(0, 5).map(row => ({ primitive: row.primitive, question: row.question.en, state: row.state.en, options: row.options.map(o => ({ id: o.id, description: o.description.en })) }));
    const fiveMs = [];
    for (let i = 0; i < 10; i++) { const before = performance.now(); await model.run(five, maxTokens); fiveMs.push(performance.now() - before); }
    const tokenCounts = rows.filter(r => !r.error).map(r => r.tokens).sort((a, b) => a - b);
    const gate = germanGate({ de, en, paired: complete ? 60 : 0, verified: true });
    const sourceHash = file => createHash('sha256').update(readFileSync(new URL(file, import.meta.url))).digest('hex');
    const require = createRequire(resolve(options['runtime-package']));
    const report = {
      schema: 'plur1bus.decision-candidate/1', at: new Date().toISOString(), label: options.label,
      source: options.source ? JSON.parse(options.source) : null, manifestVerified: Boolean(manifest), artifacts,
      node: process.version, onnxruntimeNode: packageVersion(require, 'onnxruntime-node'), transformersJs: packageVersion(require, '@huggingface/transformers'),
      platform: platform(), arch: arch(), os: release(), cpu: cpuInfo(), totalMemoryBytes: totalmem(), freeMemoryBeforeBytes, freeMemoryAfterBytes: freemem(),
      fileCacheState: 'uncontrolled', threads, maxTokens: maxTokens ?? null, specialTokens: model.specialTokens,
      fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'), labelSource: fixture.labelSource,
      runnerSha256: sourceHash('./decision-laya-candidates.mjs'), libSha256: sourceHash('./decision-laya-lib.mjs'),
      loadMs, ...summarizeLatencyPhases(latencies), latency: { n: latencies.length, p50: percentile(latencies, .5), p95: percentile(latencies, .95) },
      fiveQuestionBatch: { n: 10, p50: percentile(fiveMs, .5), p95: percentile(fiveMs, .95) }, maxRssKiB: process.resourceUsage().maxRSS,
      sequenceTokens: { min: tokenCounts[0] ?? null, p50: percentile(tokenCounts, .5), p95: percentile(tokenCounts, .95), max: tokenCounts.at(-1) ?? null, truncatedRows: rows.filter(r => r.truncated).length, errorRows: rows.filter(r => r.error).length },
      contention: { loadAverageStart: loadStart, loadAverageEnd: loadAverage(), inferenceLoop: loopContention, foreignCpuShareByChunkOf30Calls: chunks, wholeProcess: contention(wholeStart, snapshot(), logicalCpus) },
      metrics: { de, en }, germanGate: gate, automaticGermanEligibility: false,
      eligibilityReason: 'Requires independent label validation, role comparison and reference-hardware evidence', perUseCase, rows,
    };
    await writeFile(options.out, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ...report, rows: undefined, artifacts: undefined, perUseCase: undefined, cpu: undefined }, null, 2));
  } finally { await model.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
