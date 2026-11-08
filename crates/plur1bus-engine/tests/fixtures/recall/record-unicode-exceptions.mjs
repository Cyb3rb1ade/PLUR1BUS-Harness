// Controller F3 (2026-11-08): explicit RE-D17 presentation exceptions.
// This transforms existing actual Node observations; it never edits the goldens.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root = process.env.PLUR1BUS_ENGINE_SRC;
assert.equal(process.version, 'v24.21.0');
const sourcePath = path.join(root, 'lib/inject-budget.js');
const sha256 = value => createHash('sha256').update(value).digest('hex');
assert.equal(sha256(readFileSync(sourcePath)), '5897fe0a629543e60997e4749f4692c841a8f21a66526c618d7ff3fc1f52d945');
const { planGlobalInjectBudget } = await import(pathToFileURL(sourcePath));
const clean = text => [...text].filter(char => !/^[\uD800-\uDFFF]$/.test(char)).join('');
const decode = text => typeof text === 'string' ? text : text.parts.join((text.joiner ?? []).join(''));
const cases = [];
for (const file of readdirSync(new URL('./golden/render/', import.meta.url)).sort()) {
  if (!file.endsWith('.json')) continue;
  const bytes = readFileSync(new URL(`./golden/render/${file}`, import.meta.url));
  for (const item of JSON.parse(bytes).cases) {
    if (item.input.kind || !item.rawLine) continue;
    const nodeRawLine = decode(item.rawLine);
    const result = JSON.parse(nodeRawLine);
    if (!Array.isArray(result?.blocks)) continue;
    for (const block of result.blocks) { block.text = clean(block.text); block.chars = block.text.length; }
    if (result.degraded) result.degraded.detail = clean(result.degraded.detail);
    if (JSON.stringify(result) === nodeRawLine) continue;
    const joined = planGlobalInjectBudget({ blocks: result.blocks, maxChars: result.capChars });
    result.deferrals = [...result.deferrals.filter(d => d.reason !== 'global-cap'), ...joined.deferrals];
    cases.push({ golden: file.replace('.json', ''), variant: item.input.variant,
      nodeGoldenSha256: sha256(bytes), nodeRawLineSha256: sha256(nodeRawLine),
      rustRawLine: JSON.stringify(result), rustJoinedLine: JSON.stringify(joined) });
  }
}
const traceBytes = readFileSync(new URL('./golden/runtime-trace.json', import.meta.url));
const trace = JSON.parse(traceBytes);
const previews = [];
trace.expected.forEach((limits, input) => limits.forEach((units, l) => {
  const text = String.fromCharCode(...units); const output = clean(text);
  if (output !== text) previews.push({ input, limit: trace.limits[l], nodeUnits: units,
    rustUnits: Array.from({ length: output.length }, (_, i) => output.charCodeAt(i)) });
}));
writeFileSync(new URL('./unicode-exceptions.json', import.meta.url), JSON.stringify({
  ruling: 'RE-D17/F3', authority: 'Controller 2026-11-08 04:55',
  reason: 'Visible UTF-16 budget cuts stop before a split pair; identity material is unchanged.',
  traceGoldenSha256: sha256(traceBytes), cases, previews
}, null, 2) + '\n');
console.log(`Explicit exceptions: ${cases.length} render cases, ${previews.length} previews`);
