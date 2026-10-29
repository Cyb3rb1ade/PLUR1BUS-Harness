#!/usr/bin/env node
// Whether the platform legs of dependency-licenses.yml run. The workflow starts on every pull request so that its gate
// always reports and can be a required check; the legs run only when the pull request touches an input of the licence
// report. Every other event runs them, and so does an empty diff.
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { changedFiles } from './macos-plan.mjs';

// What the report depends on: the manifests and lockfiles of the three ecosystems, the Hermes provider, the policy and
// exception files, the auditor with its test, and this selection with its workflow.
export const LICENCE_INPUTS = [
  /(?:^|\/)package\.json$/,
  /^pnpm-lock\.yaml$/,
  /(?:^|\/)Cargo\.(?:toml|lock)$/,
  /(?:^|\/)pyproject\.toml$/,
  /^hosts\/hermes\/plur1bus\//,
  /^docs\/dependency-[^/]*$/,
  /^scripts\/audit-deps\.mjs$/,
  /^scripts\/test\/audit-deps\.test\.mjs$/,
  /^scripts\/ci\/license-[^/]*$/,
  /^\.github\/workflows\/dependency-licenses\.yml$/,
];

export function relevant({ event, files }) {
  if (!Array.isArray(files) || files.some(f => typeof f !== 'string')) throw new Error('files must be an array of paths');
  return event !== 'pull_request' || !files.length || files.some(file => LICENCE_INPUTS.some(re => re.test(file)));
}

function main() {
  const e = process.env;
  const event = e.EVENT_NAME ?? '';
  const files = event === 'pull_request' ? changedFiles(e.BASE_SHA, e.HEAD_SHA) : [];
  const text = `relevant=${relevant({ event, files })}\n`;
  if (e.GITHUB_OUTPUT) appendFileSync(e.GITHUB_OUTPUT, text); else process.stdout.write(text);
  console.error(`license-changes: ${files.length} paths, ${event}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
