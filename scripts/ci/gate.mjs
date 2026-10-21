#!/usr/bin/env node
// The only required check: validate both classifier outputs and every dependency result.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const KEYS = ['proceed', 'rust', 'ts-core', 'web', 'python', 'documents', 'workflows', 'engine-pin', 'docs-only'];
export function selections(o) {
  const enabled = o.proceed === 'true';
  const runtime = o.rust === 'true' || o['ts-core'] === 'true';
  return {
    'docs-hygiene': enabled,
    unit: enabled && runtime,
    'core-unit-shard': enabled && o['ts-core'] === 'true',
    'core-unit': enabled && o['ts-core'] === 'true',
    system: enabled && runtime,
    service: enabled && runtime,
    'python-host': enabled && (runtime || o.python === 'true'),
    wsl: enabled && (runtime || o.python === 'true'),
    'web-browser-build': enabled && o.web === 'true',
    'web-browser-shard': enabled && o.web === 'true',
    'web-browser': enabled && o.web === 'true',
    'release-scripts': enabled && (runtime || o.workflows === 'true'),
    sandbox: enabled && runtime,
    'perf-startup': enabled && runtime,
    'perf-budgets': enabled && runtime,
    'documents-golden': enabled && o.documents === 'true',
  };
}

const ADVISORY = new Set(['perf-startup', 'perf-budgets']);

export function evaluateGate(needs) {
  if (needs?.changes?.result !== 'success') return ['changes must succeed'];
  const outputs = needs.changes.outputs ?? {};
  const invalid = KEYS.filter(k => outputs[k] !== 'true' && outputs[k] !== 'false');
  if (invalid.length) return [`missing or invalid changes outputs: ${invalid.join(', ')}`];
  const errors = [];
  const selected = selections(outputs);
  for (const job of Object.keys(needs)) if (job !== 'changes' && !(job in selected)) errors.push(`unrecognized job: ${job}`);
  for (const [job, required] of Object.entries(selected)) {
    const result = needs[job]?.result;
    const accepted = ADVISORY.has(job) ? ['success', 'failure', 'skipped'] : required ? ['success'] : ['success', 'skipped'];
    if (!accepted.includes(result)) {
      errors.push(`${job}: ${result ?? 'missing'} (required=${required})`);
    }
  }
  return errors;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const errors = evaluateGate(JSON.parse(process.env.NEEDS ?? 'null'));
    for (const error of errors) console.error(error);
    if (errors.length) process.exitCode = 1;
    else console.log('ci-gate: required checks succeeded; advisory outcomes are complete');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
