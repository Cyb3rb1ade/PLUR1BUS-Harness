// Actual pinned queue behavior with synthetic foreign entries; no user data or network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.version, 'v24.21.0');
const root = process.env.PLUR1BUS_ENGINE_SRC;
assert.ok(root);
const provenance = JSON.parse(readFileSync(new URL('./golden/queue.json', import.meta.url))).recordedFrom;
for (const [name, hash] of Object.entries(provenance.sourceHashes)) {
  assert.equal(createHash('sha256').update(readFileSync(path.join(root, name))).digest('hex'), hash);
}
const api = await import(pathToFileURL(path.join(root, 'lib/post-turn-queue.js')));
const payloads = [
  ['foreign', '{"agentId":"beta","turns":[]}'],
  ['missing', '{"turns":[]}'],
  ['duplicate-foreign-last', '{"agentId":"alpha","agentId":"beta"}'],
  ['duplicate-owner-last', '{"agentId":"beta","agentId":"alpha"}'],
  ['link', '{"agentId":"alpha","turns":["synthetic private sentence"]}'],
  ['case-alias', null],
];
async function run() {
  const cases = [];
  for (const [name, payload] of payloads) {
    const base = mkdtempSync(path.join(tmpdir(), 'rx6-isolation-'));
    try {
      const owner = name === 'case-alias' ? 'Alpha' : 'alpha';
      const entry = api.enqueuePostTurnWork(base, owner, {}, { now: 1_790_000_000_000 });
      const file = path.join(base, '.post-turn-queue', owner, entry.file);
      const outside = path.join(base, 'synthetic-outside.json');
      if (name === 'link') {
        writeFileSync(outside, payload); unlinkSync(file); symlinkSync(outside, file);
      } else if (payload !== null) writeFileSync(file, payload);
      const aliases = name === 'case-alias' && existsSync(path.join(base, '.post-turn-queue/alpha', entry.file));
      const count = api.countPostTurnWork(base, 'alpha');
      let called = 0, observedAgent = null;
      const result = await api.drainPostTurnWork(base, 'alpha', entry => {
        called++; observedAgent = entry.agentId ?? null; return true;
      });
      cases.push({ name, payload, aliases, count, called, observedAgent, processed: result.processed,
        remaining: existsSync(file), outsideUnchanged: name === 'link' ? readFileSync(outside, 'utf8') === payload : null,
        rustException: 'exact-agent-and-ordinary-file' });
    } finally { rmSync(base, { recursive: true, force: true }); }
  }
  return cases;
}
const cases = await run();
assert.deepEqual(await run(), cases);
writeFileSync(new URL('./golden/post-turn-isolation.json', import.meta.url), JSON.stringify({
  recordedFrom: { engine: provenance.engine, commit: provenance.commit, node: provenance.node, sourceHashes: provenance.sourceHashes, platform: process.platform, normalization: 'UUID/file names omitted; no content emitted by callback' }, cases,
}, null, 2) + '\n');
console.log(`Recorded ${cases.length} actual Node isolation cases twice`);
