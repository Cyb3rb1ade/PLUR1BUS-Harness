// F5: actual pinned textPreview + diagnostic trace exports, never Rust-generated expectations.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root = process.env.PLUR1BUS_ENGINE_SRC;
assert.equal(process.version, 'v24.21.0');
const source = JSON.parse(readFileSync(new URL('./namespace-sources.json', import.meta.url))).runtime;
const files = ['lib/recall-pipeline.js', 'lib/recall-decision-trace.js'];
for (const file of files) assert.equal(createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex'), source.sha256[file]);
const pipeline = readFileSync(path.join(root, files[0]), 'utf8');
assert.ok(pipeline.includes('return `canonical:${textPreview(canonical.heading || canonical.text, 40)}`;'));
const node = await import(pathToFileURL(path.join(root, files[1])));
const units = text => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const headings = ['short', 'z'.repeat(39) + '😀 rest', 'é'.repeat(39) + '🤖suffix', 'α'.repeat(38) + '😀rest', 'words before ' + 'ordinary words '.repeat(6)];
function record() {
  return headings.map(heading => {
    const id = `canonical:${node.textPreview(heading, 40)}`;
    const trace = node.createRecallDecisionTrace({ query: '', maxTextPreviewChars: 2 });
    node.addTraceCandidate(trace, { id, source: 'canonical', text: heading });
    node.addTraceDecision(trace, { memoryId: id, action: 'inclusion', stage: 'canonical' });
    node.addTraceGuard(trace, { name: 'canonical-test', passed: true, memoryId: id });
    return { heading, nodeIdUnits: units(id), candidateIdUnits: units(trace.candidates[0].id), decisionIdUnits: units(trace.decisions[0].memoryId), guardIdUnits: units(trace.guards[0].memoryId) };
  });
}
const cases = record(); assert.deepEqual(record(), cases);
writeFileSync(new URL('./golden/runtime-trace-ids.json', import.meta.url), JSON.stringify({ recordedFrom: { commit: source.commit, node: process.version, sha256: Object.fromEntries(files.map(file => [file, source.sha256[file]])) }, cases }, null, 2) + '\n');
console.log(`Recorded ${cases.length} canonical diagnostic ID cases twice`);
