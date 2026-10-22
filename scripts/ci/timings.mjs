#!/usr/bin/env node
// Read-only, bounded Actions snapshot. No polling and no access-token handling in this script.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
function seconds(start, end) {
  const delta = timestamp(end) - timestamp(start);
  return Number.isFinite(delta) && delta >= 0 ? delta / 1000 : null;
}
function percentile(values, fraction) {
  if (!values.length) return null;
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
}

export function summarize({ runs, jobs }) {
  const dates = runs.map(r => timestamp(r.created_at)).filter(Number.isFinite);
  const windowDays = dates.length ? Math.max(1, (Math.max(...dates) - Math.min(...dates)) / 86400000) : 1;
  const grouped = new Map();
  for (const entry of jobs) for (const job of entry.jobs) {
    if (job.name.includes('${{')) continue;
    let group = grouped.get(job.name);
    if (!group) grouped.set(job.name, group = { count: 0, runs: new Set(), duration: [], wait: [] });
    group.count++;
    group.runs.add(entry.runId);
    // Skipped jobs have synthetic timestamps; pending/running durations are censored.
    if (job.conclusion === 'skipped' || !['in_progress', 'completed'].includes(job.status)) continue;
    const wait = seconds(job.created_at, job.started_at);
    if (wait !== null) group.wait.push(wait);
    const duration = seconds(job.started_at, job.completed_at);
    if (job.status === 'completed' && duration !== null) group.duration.push(duration);
  }
  const cancelledRuns = runs.filter(r => r.conclusion === 'cancelled').length;
  const supersededCandidates = runs.filter(r => r.conclusion === 'cancelled' && runs.some(newer =>
    newer.head_branch === r.head_branch && newer.event === r.event && newer.head_sha !== r.head_sha &&
    timestamp(newer.created_at) > timestamp(r.created_at))).length;
  return {
    runCount: runs.length, incompleteRuns: runs.filter(r => r.status !== 'completed').length,
    cancelledRuns, cancelledFraction: runs.length ? cancelledRuns / runs.length : 0,
    supersededCandidates, windowDays,
    firstCreatedAt: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
    lastCreatedAt: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
    runIds: runs.map(r => r.id),
    jobs: [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([name, g]) => ({
      name, jobs: g.count, runs: g.runs.size, durationSamples: g.duration.length, waitSamples: g.wait.length,
      p50DurationSeconds: percentile(g.duration, 0.5), p95DurationSeconds: percentile(g.duration, 0.95),
      p50WaitSeconds: percentile(g.wait, 0.5), p95WaitSeconds: percentile(g.wait, 0.95),
      runsPerDay: g.runs.size / windowDays,
    })),
  };
}

/** Fetch each page once. Attempts are explicit so a re-run cannot mix jobs from earlier attempts. */
export async function collectSnapshot({ repo, workflow = 'ci.yml', count = 50, api = path =>
  JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })) }) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('runs must be a positive integer');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repo must be owner/repository');
  const runs = [];
  for (let page = 1; runs.length < count; page++) {
    const result = await api(`repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=100&page=${page}`);
    runs.push(...result.workflow_runs.slice(0, count - runs.length));
    if (result.workflow_runs.length < 100) break;
  }
  const jobs = [];
  for (const run of runs) {
    const entry = { runId: run.id, jobs: [] };
    for (let page = 1; ; page++) {
      const result = await api(`repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`);
      entry.jobs.push(...result.jobs);
      if (result.jobs.length < 100) break;
    }
    jobs.push(entry);
  }
  return { repo, workflow, collectedAt: new Date().toISOString(), runs, jobs };
}

export function renderMarkdown(s) {
  const fmt = value => value === null ? 'n/a' : value.toFixed(1);
  const cell = text => String(text).replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
  return [
    '# CI baseline', '',
    `Runs: ${s.runCount}; incomplete: ${s.incompleteRuns}; cancelled: ${s.cancelledRuns} (${(100 * s.cancelledFraction).toFixed(1)}%); newer-head cancellation candidates: ${s.supersededCandidates}.`,
    `Created window (UTC): ${s.firstCreatedAt ?? 'n/a'} – ${s.lastCreatedAt ?? 'n/a'}. Frequency denominator: ${s.windowDays.toFixed(3)} days (minimum one day).`, '',
    '| Job | p50/p95 duration (s) | p50/p95 wait (s) | Runs/day | Duration/wait samples |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...s.jobs.map(j => `| ${cell(j.name)} | ${fmt(j.p50DurationSeconds)} / ${fmt(j.p95DurationSeconds)} | ${fmt(j.p50WaitSeconds)} / ${fmt(j.p95WaitSeconds)} | ${fmt(j.runsPerDay)} | ${j.durationSamples} / ${j.waitSamples} |`), '',
    'Nearest-rank percentiles. Wait = job.started_at − job.created_at: this includes dependency/environment delay and is not pure runner queue time. Unresolved matrix job names are excluded from job groups and samples. Skipped jobs and missing/invalid timestamps are excluded from timing samples. Running jobs contribute waiting only; unfinished durations are censored. Cancelled jobs contribute partial execution durations, not full-suite estimates.', '',
    'The API does not state why a run was cancelled. A cancelled run with a newer different head on the same branch and event is only a supersession candidate, never proof of concurrency cancellation. Runs are sampled once; no CI polling.', '',
    `Run IDs (latest attempt of each): ${s.runIds.join(', ')}.`, '',
  ].join('\n');
}

async function main(argv) {
  const options = { repo: 'Cyb3rb1ade/PLUR1BUS-Harness', workflow: 'ci.yml', count: 50 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--repo', '--workflow', '--runs', '--out', '--input'].includes(key) || !argv[i + 1]) {
      throw new Error('usage: timings.mjs [--repo owner/repo] [--workflow ci.yml] [--runs N] [--out prefix] [--input snapshot.json]');
    }
    const value = argv[++i];
    options[key === '--runs' ? 'count' : key.slice(2)] = key === '--runs' ? Number(value) : value;
  }
  const snapshot = options.input ? JSON.parse(readFileSync(options.input, 'utf8')) : await collectSnapshot(options);
  const summary = summarize(snapshot);
  const markdown = renderMarkdown(summary);
  if (options.out) {
    writeFileSync(`${options.out}.json`, JSON.stringify(snapshot, null, 2) + '\n');
    writeFileSync(`${options.out}.md`, markdown);
  }
  process.stdout.write(markdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
