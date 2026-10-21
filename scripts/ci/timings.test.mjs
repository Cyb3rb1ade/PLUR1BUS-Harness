import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSnapshot, summarize, renderMarkdown } from './timings.mjs';

const at = seconds => new Date(Date.UTC(2026, 9, 20, 0, 0, seconds)).toISOString();
const run = (id, extra = {}) => ({ id, head_branch: 'feature', head_sha: `sha${id}`, event: 'pull_request',
  created_at: at(id * 100), status: 'completed', conclusion: 'success', run_attempt: 1, ...extra });
const job = (seconds, extra = {}) => ({ name: 'unit (ubuntu)', status: 'completed', conclusion: 'success',
  created_at: at(0), started_at: at(20), completed_at: at(20 + seconds), ...extra });

test('job percentiles use valid executions, separate waiting and report sample counts', () => {
  const s = summarize({ runs: [run(1), run(2)], jobs: [
    { runId: 1, jobs: [job(10), job(30), job(999, { conclusion: 'skipped' })] },
    { runId: 2, jobs: [job(50), job(70), job(90), job(1, { started_at: null })] },
  ] });
  assert.deepEqual(s.jobs[0], { name: 'unit (ubuntu)', jobs: 7, runs: 2, durationSamples: 5,
    waitSamples: 5, p50DurationSeconds: 50, p95DurationSeconds: 90,
    p50WaitSeconds: 20, p95WaitSeconds: 20, runsPerDay: 2 });
});

test('a run still waiting is censored, not a zero-second execution', () => {
  const s = summarize({ runs: [run(1, { status: 'queued', conclusion: null })],
    jobs: [{ runId: 1, jobs: [job(0, { status: 'queued', conclusion: null, started_at: null, completed_at: null })] }] });
  assert.equal(s.incompleteRuns, 1);
  assert.equal(s.jobs[0].p50DurationSeconds, null);
  assert.equal(s.jobs[0].p50WaitSeconds, null);
  assert.match(renderMarkdown(s), /n\/a/);
});

test('queued jobs with synthetic started_at are not measured as zero-wait starts', () => {
  const s = summarize({ runs: [run(1, { status: 'queued', conclusion: null })],
    jobs: [{ runId: 1, jobs: [job(0, { status: 'queued', conclusion: null,
      started_at: at(0), completed_at: null })] }] });
  assert.equal(s.jobs[0].waitSamples, 0);
  assert.equal(s.jobs[0].p50WaitSeconds, null);
});

test('cancellations and newer-head candidates are distinct, branch and event scoped', () => {
  const s = summarize({ runs: [run(5), run(4, { event: 'push', conclusion: 'cancelled' }),
    run(3, { head_branch: 'other', conclusion: 'cancelled' }),
    run(2, { conclusion: 'cancelled' }), run(1, { created_at: at(450), head_sha: 'sha5', conclusion: 'cancelled' })], jobs: [] });
  assert.equal(s.cancelledRuns, 4);
  assert.equal(s.supersededCandidates, 1);
  assert.equal(s.cancelledFraction, 0.8);
});

test('negative and missing timestamps never become measured durations or waits', () => {
  const s = summarize({ runs: [run(1)], jobs: [{ runId: 1, jobs: [job(10, { created_at: at(50), completed_at: at(10) })] }] });
  assert.equal(s.jobs[0].durationSamples, 0);
  assert.equal(s.jobs[0].waitSamples, 0);
});

test('collection paginates runs and jobs and requests the selected attempt only', async () => {
  const calls = [];
  const api = async path => {
    calls.push(path);
    if (path.includes('/attempts/')) return { jobs: path.endsWith('page=1') ? Array.from({ length: 100 }, () => job(2)) : [job(3)] };
    return { workflow_runs: path.endsWith('page=1') ? Array.from({ length: 100 }, (_, i) => run(i + 1, { run_attempt: 2 })) : [run(101)] };
  };
  const snapshot = await collectSnapshot({ repo: 'owner/repo', workflow: 'ci.yml', count: 101, api });
  assert.equal(snapshot.runs.length, 101);
  assert.equal(snapshot.jobs[0].jobs.length, 101);
  assert(calls.includes('repos/owner/repo/actions/runs/1/attempts/2/jobs?per_page=100&page=2'));
  assert(calls.includes('repos/owner/repo/actions/workflows/ci.yml/runs?per_page=100&page=2'));
});

test('invalid collection bounds fail before making any API call', async () => {
  for (const count of [0, -1, 1.5, NaN]) {
    await assert.rejects(collectSnapshot({ repo: 'owner/repo', workflow: 'ci.yml', count,
      api: () => assert.fail('must not call API') }), /positive integer/);
  }
});

test('API errors propagate instead of producing a partial baseline', async () => {
  await assert.rejects(collectSnapshot({ repo: 'owner/repo', workflow: 'ci.yml', count: 1,
    api: async () => { throw new Error('HTTP 403'); } }), /403/);
});
