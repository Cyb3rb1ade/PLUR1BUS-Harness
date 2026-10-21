#!/usr/bin/env node
// The only required check: validate both classifier outputs and every dependency result.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const KEYS = ['proceed', 'macos', 'rust', 'ts-core', 'web', 'python', 'documents', 'workflows', 'engine-pin', 'docs-only'];

// The explicit dependency set: gate `needs` exactly these jobs (workflow-contract.test.mjs proves it). Each required job aggregates
// its own matrix or shards (`web-browser` fails unless the build and every shard succeeded). A job outside this set is
// never in the gate's `needs`: the gate would wait for it, and a slow, flaky or experimental leg (windows/macos unit,
// python-host windows-11-arm, startup/budget advisories, ...) must neither delay nor fail the merge decision.
// Explicit exception requested for #621: macOS browser shards are an advisory dependency, so the gate waits for them
// but accepts completed failure/skipped outcomes. Only missing/cancelled/malformed results block it.
export function selections(o) {
  const enabled = o.proceed === 'true';
  const runtime = o.rust === 'true' || o['ts-core'] === 'true';
  return {
    'docs-hygiene': enabled,
    unit: enabled && runtime, // ubuntu-24.04 only; the macos/windows legs are the ungated `unit-os`
    'core-unit-shard': enabled && o['ts-core'] === 'true',
    'core-unit': enabled && o['ts-core'] === 'true',
    wsl: enabled && (runtime || o.python === 'true'),
    'web-browser': enabled && o.web === 'true',
    'web-browser-macos': enabled && o.web === 'true' && o.macos === 'true',
  };
}

export const ADVISORY = new Set(['web-browser-macos']);

// Jobs of ci.yml that run but are deliberately not part of the gate (see docs/ci.md, "Required check and failures").
export const UNGATED = ['unit-os', 'system', 'service', 'python-host', 'web-browser-build', 'web-browser-shard',
  'release-scripts', 'sandbox', 'perf-startup', 'perf-budgets', 'documents-golden'];

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
    else console.log('ci-gate: every selected required check succeeded');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
