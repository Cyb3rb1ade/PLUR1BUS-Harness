import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.PLUR1BUS_ENGINE_SRC;
assert.ok(root); assert.equal(process.version, 'v24.21.0');
const source = JSON.parse(readFileSync(new URL('./write-sources.json', import.meta.url), 'utf8'));
const files = [];
function walk(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name.endsWith('.js')) files.push(file); } }
walk(path.join(root, 'engine')); walk(path.join(root, 'lib'));
const hash = createHash('sha256');
for (const file of files.sort()) { hash.update(`${path.relative(root, file)}\0`); hash.update(readFileSync(file)); hash.update('\0'); }
assert.equal(hash.digest('hex'), source.treeSha256);
const load = file => import(pathToFileURL(path.join(root, file)));
const { createNeoStore } = await load('lib/neo-arch.js');
const cases = [
 { name: 'all-revisions', ids: ['gone'], before: '{"source":"gone","target":"peer","strength":0.3}\n{"source":"gone","target":"peer","strength":0.8}\n{"source":"left","target":"right"}\n' },
 { name: 'ownerless-and-foreign', ids: ['gone'], before: '{"source":"gone","target":"peer"}\n{"source":"peer","target":"gone","ownerUserId":"foreign"}\n' },
 { name: 'malformed-and-partial', ids: ['gone'], before: '  \n{"source":"gone","target":"peer"}\nnot-json\n{"source":"keep","target":"tail"}' },
 { name: 'coerced-numeric-id', ids: ['7'], before: '{"source":7,"target":"peer"}\n' },
 { name: 'no-match', ids: ['gone'], before: ' \n{"source":"other","target":"peer"}' },
 { name: 'absent', ids: ['gone'], before: null },
];
function record() {
 const temp = realpathSync(mkdtempSync(path.join(tmpdir(), 'rx3-unimport-graph-')));
 try { return cases.map((c, i) => {
  const store = createNeoStore(temp, `fixture-${i}`);
  if (c.before !== null) { mkdirSync(store.paths.workspaceDir, { recursive:true }); writeFileSync(store.paths.graph, c.before); }
  const result = store.removeGraphEdgesTouching(c.ids);
  const after = existsSync(store.paths.graph) ? readFileSync(store.paths.graph, 'utf8') : null;
  const replay = store.removeGraphEdgesTouching(c.ids);
  return { ...c, result, after, replay };
 }); } finally { rmSync(temp, { recursive:true, force:true }); }
}
const recorded = record(); assert.deepEqual(record(), recorded);
writeFileSync(new URL('./golden/unimport-graph.json', import.meta.url), JSON.stringify({ recordedFrom: { source, node:process.version }, cases:recorded }, null, 2)+'\n');
console.log('Recorded actual Node graph cleanup twice');
