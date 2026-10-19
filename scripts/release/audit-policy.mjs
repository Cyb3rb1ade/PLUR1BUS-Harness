import { appendFileSync, readFileSync, realpathSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY = 86_400_000;
const severities = new Set(['low', 'moderate', 'high', 'critical', 'unknown', 'info']);
const idPattern = /^(?:GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|RUSTSEC-\d{4}-\d{4})$/;

export function validateAllowlist(policy, now = new Date()) {
  if (policy?.version !== 1 || !Array.isArray(policy.exceptions) || Object.keys(policy).sort().join() !== 'exceptions,version') throw new Error('Invalid audit allowlist');
  const seen = new Set();
  for (const entry of policy.exceptions) {
    if (Object.keys(entry).sort().join() !== 'advisoryId,created,expires,reason' || !idPattern.test(entry.advisoryId) || typeof entry.reason !== 'string' || !entry.reason.trim() || seen.has(entry.advisoryId)) throw new Error('Invalid or duplicate audit exception');
    seen.add(entry.advisoryId);
    for (const key of ['created', 'expires']) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry[key]) || !Number.isFinite(Date.parse(entry[key])) || new Date(entry[key]).toISOString().slice(0, 10) !== entry[key]) throw new Error('Invalid exception date');
    }
    const start = Date.parse(entry.created), end = Date.parse(entry.expires);
    if (start > now.getTime() || end <= start || end - start > 90 * DAY || end <= now.getTime() || end - now.getTime() > 90 * DAY) throw new Error(`Expired or excessive exception: ${entry.advisoryId}`);
  }
  return new Map(policy.exceptions.map(entry => [entry.advisoryId, entry]));
}

// CVSS is owned by FIRST and used by permission. Base equations/weights:
// https://www.first.org/cvss/v3.1/specification-document (sections 7.1 and 7.4).
// Unsupported/unscored vectors remain unknown; production unknowns fail closed.
export function cvssSeverity(vector) {
  if (typeof vector !== 'string' || !/^CVSS:3\.[01]\//.test(vector)) return 'unknown';
  const parts = vector.split('/').slice(1).map(part => part.split(':'));
  const m = Object.fromEntries(parts);
  const weights = { AV: { N: .85, A: .62, L: .55, P: .2 }, AC: { L: .77, H: .44 }, UI: { N: .85, R: .62 }, C: { H: .56, L: .22, N: 0 }, I: { H: .56, L: .22, N: 0 }, A: { H: .56, L: .22, N: 0 }, PR: m.S === 'C' ? { N: .85, L: .68, H: .5 } : { N: .85, L: .62, H: .27 } };
  if (!['U', 'C'].includes(m.S) || new Set(parts.map(p => p[0])).size !== parts.length || Object.entries(weights).some(([key, values]) => values[m[key]] === undefined)) return 'unknown';
  const w = Object.fromEntries(Object.entries(weights).map(([key, values]) => [key, values[m[key]]]));
  const iss = 1 - (1 - w.C) * (1 - w.I) * (1 - w.A);
  const impact = m.S === 'U' ? 6.42 * iss : 7.52 * (iss - .029) - 3.25 * (iss - .02) ** 15;
  const exploitability = 8.22 * w.AV * w.AC * w.PR * w.UI;
  const score = impact <= 0 ? 0 : Math.ceil((Math.min(10, (impact + exploitability) * (m.S === 'C' ? 1.08 : 1)) - 1e-10) * 10) / 10;
  return score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'moderate' : 'low';
}

export function parsePnpm(raw) {
  const report = JSON.parse(raw);
  if (!report.advisories || typeof report.advisories !== 'object' || Array.isArray(report.advisories) || !report.metadata?.vulnerabilities || report.error) throw new Error('Incomplete pnpm audit report');
  const items = Object.values(report.advisories).map(a => {
    if (!idPattern.test(a.github_advisory_id) || typeof a.module_name !== 'string' || !severities.has(a.severity)) throw new Error('Invalid pnpm advisory');
    return { id: a.github_advisory_id, package: a.module_name, severity: a.severity, title: a.title };
  });
  const counts = ['info', 'low', 'moderate', 'high', 'critical'].map(s => report.metadata.vulnerabilities[s]);
  if (counts.some(n => !Number.isInteger(n) || n < 0) || counts.reduce((a, b) => a + b, 0) !== items.length) throw new Error('Inconsistent pnpm audit counts');
  return items;
}

export function assertNoPnpmIgnores(raw) {
  if (!raw.trim()) return;
  const config = JSON.parse(raw);
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.entries(config).some(([key, value]) => !['ignoreCves', 'ignoreGhsas'].includes(key) || !Array.isArray(value) || value.length)) throw new Error('pnpm auditConfig suppressions are forbidden; use audit-allowlist.json');
}

export function parseCargo(raw, diagnostics) {
  const report = JSON.parse(raw);
  if (!Array.isArray(report.vulnerabilities) || !report.warnings || !Array.isArray(report.settings?.ignore) || report.settings.ignore.length || report.settings.severity !== null || !Number.isInteger(report.lockfile?.['dependency-count'])) throw new Error('Incomplete or filtered cargo-deny report');
  const messages = diagnostics.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (!messages.some(m => m.type === 'summary') || messages.some(m => (m.type === 'diagnostic' && m.fields?.severity === 'error' && !['vulnerability', 'unsound', 'unmaintained', 'notice', 'yanked'].includes(m.fields?.code)) || [m.level, m.fields?.level].some(level => String(level).toLowerCase() === 'error'))) throw new Error('cargo-deny collection failed');
  const finding = (v, informational) => {
    if (!idPattern.test(v.advisory?.id) || typeof v.package?.name !== 'string' || typeof v.package.version !== 'string') throw new Error('Invalid RustSec finding');
    return { id: v.advisory.id, package: `${v.package.name}@${v.package.version}`, severity: informational ? 'info' : cvssSeverity(v.advisory.cvss), title: v.advisory.title };
  };
  return [
    ...report.vulnerabilities.map(v => finding(v, false)),
    ...Object.entries(report.warnings).flatMap(([kind, list]) => {
      if (!Array.isArray(list)) throw new Error('Invalid RustSec warnings');
      return list.map(v => finding(v, !['unsound', 'vulnerability'].includes(kind)));
    }),
    ...messages.filter(m => m.type === 'diagnostic' && m.fields?.code === 'yanked').map(m => ({ id: 'yanked', package: m.fields.labels?.[0]?.span ?? 'crate', severity: 'info', title: m.fields.message })),
  ];
}

const key = item => `${item.id}:${item.package}`;
export function evaluate(production, all, exceptions) {
  const prodKeys = new Set(production.map(key));
  const merged = new Map([...all, ...production].map(item => [key(item), item]));
  return [...merged.values()].map(item => {
    if (!severities.has(item.severity)) throw new Error('Invalid advisory severity');
    const scope = prodKeys.has(key(item)) ? 'production' : 'dev';
    const exception = scope === 'production' ? exceptions.get(item.id) : undefined;
    return { ...item, scope, exception, block: scope === 'production' && ['high', 'critical', 'unknown'].includes(item.severity) && !exception };
  });
}

const cell = value => String(value ?? '').replace(/[\r\n|<>]/g, ' ');
export function renderSummary(findings, errors) {
  const lines = ['## Release dependency audit', '', 'Production High/Critical (and unscored vulnerabilities) block. Dev findings and production Low/Moderate warn.', '', '| Ecosystem | Advisory | Package | Scope | Severity | Result |', '|---|---|---|---|---|---|'];
  for (const item of findings) lines.push(`| ${cell(item.ecosystem)} | ${cell(item.id)} | ${cell(item.package)} | ${item.scope} | ${item.severity} | ${item.block ? 'BLOCK' : item.exception ? `owner exception until ${item.exception.expires}: ${cell(item.exception.reason)}` : 'warning'} |`);
  for (const error of errors) lines.push('', `**BLOCK: ${cell(error)}**`);
  lines.push('', `${findings.filter(item => item.block).length} blocking findings; ${errors.length} collection/policy errors.`, '');
  return lines.join('\n');
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
  if (result.error || result.signal || ![0, 1].includes(result.status)) throw new Error(`${command} audit command failed`);
  return result;
}

// The PR author must be the repository owner if the allowlist differs from its
// base. CODEOWNERS additionally requests owner review; required checks/reviews
// must be enabled by the owner in GitHub branch protection.
export function assertOwnerChange(changed, event, eventName, owner) {
  if (!changed || eventName !== 'pull_request') return;
  if (event.pull_request?.user?.login !== owner) throw new Error('Only the repository owner may change audit-allowlist.json');
}

export function main(root = process.cwd()) {
  const findings = [], errors = [];
  let exceptions;
  try {
    exceptions = validateAllowlist(JSON.parse(readFileSync(join(root, 'audit-allowlist.json'), 'utf8')));
    if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
      const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      const diff = run('git', ['diff', '--name-only', `${event.pull_request.base.sha}...HEAD`, '--', 'audit-allowlist.json'], root);
      assertOwnerChange(Boolean(diff.stdout.trim()), event, 'pull_request', process.env.GITHUB_REPOSITORY_OWNER);
    }
  } catch (error) { errors.push(error.message); }
  const scratch = mkdtempSync(join(tmpdir(), 'plur1bus-audit-'));
  try {
    const config = join(scratch, 'deny.toml');
    // Never inherit deny.toml ignores or severity thresholds as hidden exceptions.
    writeFileSync(config, '[advisories]\nignore = []\n');
    let rustDatabaseError;
    try {
      const fetched = run('cargo', ['deny', '--config', config, 'fetch', 'db'], root);
      if (fetched.status !== 0) throw new Error('RustSec database refresh failed');
    } catch (error) { rustDatabaseError = error; }
    const collectors = [
      ['npm', prod => {
        assertNoPnpmIgnores(run('pnpm', ['config', 'get', 'auditConfig', '--json'], root).stdout);
        for (const name of ['ignoreCves', 'ignoreGhsas']) {
          const raw = run('pnpm', ['config', 'get', `auditConfig.${name}`, '--json'], root).stdout;
          if (raw.trim() && (!Array.isArray(JSON.parse(raw)) || JSON.parse(raw).length)) throw new Error('pnpm advisory ignores are forbidden');
        }
        return parsePnpm(run('pnpm', ['audit', ...(prod ? ['--prod'] : []), '--audit-level', 'low', '--ignore-unfixable=false', '--ignore-registry-errors=false', '--json'], root).stdout);
      }],
      ...['Cargo.toml', 'apps/desktop/Cargo.toml'].map(manifest => [manifest, prod => {
        if (rustDatabaseError) throw rustDatabaseError;
        const version = run('cargo', ['deny', '--version'], root);
        if (version.stdout.trim() !== 'cargo-deny 0.20.2') throw new Error('cargo-deny 0.20.2 is required');
        const result = run('cargo', ['deny', '--format', 'json', '--manifest-path', manifest, '--config', config, '--workspace', '--all-features', '--locked', ...(prod ? ['--exclude-dev'] : []), 'check', 'advisories', '--audit-compatible-output'], root);
        return parseCargo(result.stdout, result.stderr);
      }]),
    ];
    for (const [ecosystem, collect] of collectors) {
      try { findings.push(...evaluate(collect(true), collect(false), exceptions ?? new Map()).map(item => ({ ...item, ecosystem }))); }
      catch (error) { errors.push(`${ecosystem}: ${error.message}`); }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  const summary = renderSummary(findings, errors);
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  return errors.length || findings.some(item => item.block) ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(resolve('.'));
