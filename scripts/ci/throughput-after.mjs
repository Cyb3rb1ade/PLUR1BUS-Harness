#!/usr/bin/env node
// Offline provenance gate for P1's unchanged timing summarizer. Reads Git and a saved snapshot; never polls Actions.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const PHASES = ["P1", "P2", "P3", "P4", "P5"];
const REQUIRED_JOBS = ["ci-gate", "core-unit", ...[1, 2, 3].map(i => `core unit shard ${i}/3 (ubuntu-24.04)`)];

function ancestor(base, head) {
  return spawnSync("git", ["merge-base", "--is-ancestor", base, head], { encoding: "utf8" }).status === 0;
}

function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--check-integration") { options.checkIntegration = true; continue; }
    if (!["--input", "--integration", "--requirements", "--out"].includes(argv[i]) || !argv[i + 1]) throw new Error("usage: throughput-after.mjs --integration <40-hex commit> [--check-integration | --input snapshot.json --out cohort.json] [--requirements phases.json]");
    options[argv[i].slice(2)] = argv[i + 1];
    i++;
  }
  if (!SHA.test(options.integration ?? "") || (!options.checkIntegration && (!options.input || !options.out))) throw new Error("an exact integration commit and either preflight or input/output are required");
  const requirements = JSON.parse(readFileSync(options.requirements ?? new URL("../../.github/ci/throughput-integrations.json", import.meta.url), "utf8"));
  for (const phase of PHASES) {
    if (!SHA.test(requirements[phase] ?? "")) throw new Error(`${phase}: missing exact source commit`);
    if (!ancestor(requirements[phase], options.integration)) throw new Error(`${phase} is not integrated at ${options.integration}; no after measurement`);
  }
  const date = spawnSync("git", ["show", "-s", "--format=%cI", options.integration], { encoding: "utf8" });
  const integratedAt = Date.parse(date.stdout.trim());
  if (date.status !== 0 || !Number.isFinite(integratedAt)) throw new Error("integration commit time unavailable");
  if (options.checkIntegration) {
    console.log(`integration preflight: P1–P5 are integrated at ${options.integration}; a bounded measurement may now be collected.`);
    return;
  }
  const snapshot = JSON.parse(readFileSync(options.input, "utf8"));
  if (snapshot.repo !== "Cyb3rb1ade/PLUR1BUS-Harness" || snapshot.workflow !== "ci.yml"
      || !Array.isArray(snapshot.runs) || !Array.isArray(snapshot.jobs)) throw new Error("expected a P1 Harness ci.yml snapshot");
  const runs = snapshot.runs.filter(run => run.status === "completed" && SHA.test(run.head_sha ?? "")
    && Date.parse(run.created_at) >= integratedAt && ancestor(options.integration, run.head_sha)
    && snapshot.jobs.some(entry => entry.runId === run.id && Array.isArray(entry.jobs)));
  if (!runs.length) throw new Error("no completed post-integration runs; a historical/unfinished snapshot is not after evidence");
  const full = runs.filter(run => REQUIRED_JOBS.every(name => snapshot.jobs.some(entry => entry.runId === run.id
    && entry.jobs.some(job => job.name === name && job.status === "completed" && job.conclusion === "success"))));
  if (!full.length) throw new Error("no completed run with successful ci-gate, all three Core shards and partition gate");
  const ids = new Set(runs.map(run => run.id));
  const cohort = { ...snapshot, runs, jobs: snapshot.jobs.filter(entry => ids.has(entry.runId)), measurement: {
    kind: "post-integration", integration: options.integration, integratedAt: new Date(integratedAt).toISOString(),
    requirements, excludedRuns: snapshot.runs.length - runs.length, completeCoreRuns: full.map(run => run.id),
  } };
  writeFileSync(options.out, JSON.stringify(cohort, null, 2) + "\n");
  console.log(`after gate: ${runs.length} completed post-integration runs, ${full.length} with complete Core checks; ${cohort.measurement.excludedRuns} excluded. Use the unchanged P1 summarizer on ${options.out}.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
