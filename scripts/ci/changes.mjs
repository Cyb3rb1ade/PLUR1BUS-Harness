#!/usr/bin/env node
// Conservative PR impact selection. Unknown paths and empty diffs run every suite.
import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { changedFiles, plan, pythonMatrix } from './macos-plan.mjs';

// Markdown is also executable prompt/template data and a test input. Only known documentary paths qualify.
const documentary = file => file.startsWith('docs/') ||
  /^(?:README|AGENTS|THIRD_PARTY|CONTRIBUTING|SECURITY|CHANGELOG|CODE_OF_CONDUCT|LICENSE|NOTICE)\.(?:md|markdown)$/i.test(file) ||
  /^(?:packages|modules)\/[^/]+\/(?:README|CHANGELOG)\.(?:md|markdown)$/i.test(file);

export function classify({ event, files, enginePinChanged = false }) {
  if (!Array.isArray(files) || files.some(f => typeof f !== 'string')) throw new Error('files must be an array of paths');
  const r = { rust: false, 'ts-core': false, web: false, python: false, 'docs-only': false,
    workflows: files.some(f => f.startsWith('.github/workflows/')), 'engine-pin': enginePinChanged, documents: false };
  const all = () => { for (const k of ['rust', 'ts-core', 'web', 'python', 'documents']) r[k] = true; };
  if (event !== 'pull_request' || !files.length || enginePinChanged || r.workflows || files.some(f => f === 'Cargo.lock' || f.endsWith('/Cargo.lock'))) { all(); return r; }
  if (files.every(documentary)) { r['docs-only'] = true; return r; }
  for (const file of files) {
    if (documentary(file)) continue;
    if (/^packages\/(?:rpc-schema|config-schema|log-schema|module-api)\//.test(file)) {
      for (const key of ['rust', 'ts-core', 'web', 'python']) r[key] = true;
    } else if (/^(?:crates\/|Cargo\.|rust-toolchain\.)/.test(file)) {
      r.rust = true;
      // Core/system tests share Rust-owned fixtures and check the restore marker's source parity.
      if (/^crates\/.*\/fixtures\//.test(file) || file === 'crates/plur1bus/src/backup/restore.rs') r['ts-core'] = true;
    }
    else if (file.startsWith('packages/web/')) r.web = true;
    else if (file.startsWith('packages/')) {
      r['ts-core'] = true;
      if (file.startsWith('packages/documents/')) r.documents = true;
    } else if (/^(?:hosts\/|clients\/python\/)/.test(file)) r.python = true;
    else if (/^tests\//.test(file)) r['ts-core'] = true;
    else all(); // root config, lockfiles, scripts, new directories: fail conservative
  }
  return r;
}

function enginePin(base, cwd = process.cwd()) {
  const manifest = JSON.parse(execFileSync('git', ['show', `${base}:packages/core/package.json`], { cwd, encoding: 'utf8' }));
  const entries = Object.entries(manifest.dependencies ?? {}).filter(([name]) => name.endsWith('/plur1bus-memory'));
  if (entries.length !== 1) throw new Error('expected exactly one private Engine dependency');
  return entries[0][1];
}

function main() {
  const e = process.env;
  const event = e.EVENT_NAME ?? '';
  let files = [], enginePinChanged = false;
  if (event === 'pull_request') {
    files = changedFiles(e.BASE_SHA, e.HEAD_SHA);
    const ancestor = execFileSync('git', ['merge-base', e.BASE_SHA, e.HEAD_SHA], { encoding: 'utf8' }).trim();
    enginePinChanged = enginePin(ancestor) !== enginePin(e.HEAD_SHA);
  }
  const flags = classify({ event, files, enginePinChanged });
  const platform = plan({ event, action: e.ACTION ?? '', labelName: e.LABEL_NAME ?? '',
    labels: JSON.parse(e.LABELS || '[]'), files });
  const outputs = { ...flags, ...platform, python_matrix: JSON.stringify(pythonMatrix(platform.macos)) };
  const text = Object.entries(outputs).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  if (e.GITHUB_OUTPUT) appendFileSync(e.GITHUB_OUTPUT, text); else process.stdout.write(text);
  console.error(`changes: ${files.length} paths, ${event}, proceed=${platform.proceed}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
