import { createHash } from 'node:crypto';
import { readFileSync, existsSync, realpathSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gitText, sandboxVerifier, type VerifierPort, type VerifierCommand, type CheckKind } from './verifier.ts';
import { CollabError } from './errors.ts';
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const KINDS: CheckKind[] = ['format', 'lint', 'typecheck', 'test'];
export function detectVerifiers(files: Readonly<Record<string, string>>): { toolchain: string; commands: VerifierCommand[]; networkAllowed: boolean } {
  if (files['.plur1bus-verifiers.json']) {
    const config = JSON.parse(files['.plur1bus-verifiers.json']);
    if (!config || Object.keys(config).some(k => !['commands', 'networkAllowed'].includes(k))) throw new CollabError('invalid', 'invalid verifier conventions');
    const commands = KINDS.map(kind => { const argv = config.commands?.[kind]; if (!Array.isArray(argv) || !argv.length || argv.length > 32 || argv.some(v => typeof v !== 'string' || !v || v.length > 4096 || v.includes('\0'))) throw new CollabError('invalid', `missing verifier: ${kind}`); return { kind, argv }; });
    return { toolchain: 'project', commands, networkAllowed: config.networkAllowed === true };
  }
  const plan = (toolchain: string, argv: string[][], empty = false) => ({ toolchain, networkAllowed: false, commands: argv.map((a, i) => ({ kind: KINDS[i]!, argv: a, ...(empty && i === 0 ? { emptyOutput: true } : {}) })) });
  if (files['package.json']) {
    const p = JSON.parse(files['package.json']), scripts = p.scripts ?? {};
    const pm = String(p.packageManager ?? '').startsWith('pnpm@') || files['pnpm-lock.yaml'] ? 'pnpm' : 'npm';
    const names = [['format:check', 'check:format', 'format'], ['lint'], ['typecheck', 'check:types'], ['test']].map(candidates => candidates.find(k => typeof scripts[k] === 'string'));
    return plan('node', names.map((name, i) => name ? [pm, 'run', name] : [join('node_modules', '.bin', ['prettier', 'eslint', 'tsc', 'test-runner'][i]!), ...[['--check', '.'], ['.'], ['--noEmit'], []][i]!]));
  }
  if (files['pyproject.toml'] || files['requirements.txt']) return plan('python', [['ruff', 'format', '--check', '.'], ['ruff', 'check', '.'], ['mypy', '.'], ['pytest']]);
  if (files['Cargo.toml']) return plan('rust', [['cargo', 'fmt', '--all', '--', '--check'], ['cargo', 'clippy', '--workspace', '--all-targets', '--offline', '--', '-D', 'warnings'], ['cargo', 'check', '--workspace', '--offline'], ['cargo', 'test', '--workspace', '--offline']]);
  if (files['go.mod']) return plan('go', [['gofmt', '-l', '.'], ['go', 'vet', './...'], ['go', 'test', '-run', '^$', './...'], ['go', 'test', './...']], true);
  if (files['build.gradle'] || files['build.gradle.kts']) return plan('java', [['./gradlew', '--offline', 'spotlessCheck'], ['./gradlew', '--offline', 'checkstyleMain'], ['./gradlew', '--offline', 'compileJava'], ['./gradlew', '--offline', 'test']]);
  throw new CollabError('invalid', 'no supported coding toolchain or project conventions');
}
const MANIFESTS = ['.plur1bus-verifiers.json', 'package.json', 'pnpm-lock.yaml', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'build.gradle', 'build.gradle.kts'];
export function worktreeSnapshot(root: string): { root: string; treeHash: string; changedLines: number; files: string[]; head: string } {
  const canonical = realpathSync(root), top = realpathSync(gitText(root, ['rev-parse', '--show-toplevel']).trim());
  if (canonical !== top) throw new CollabError('invalid', 'verifier requires the bound Git worktree root');
  const head = gitText(root, ['rev-parse', 'HEAD']).trim();
  const untracked = gitText(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const diff = gitText(root, ['diff', '--binary', 'HEAD', '--']);
  const stats = gitText(root, ['diff', '--numstat', 'HEAD', '--']).trim().split('\n').filter(Boolean);
  let lines = stats.reduce((n, line) => { const [a, d] = line.split('\t'); return n + (a === '-' || d === '-' ? 200 : Number(a) + Number(d)); }, 0);
  const extra = untracked.map(path => { const absolute = realpathSync(join(root, path)); if (!absolute.startsWith(canonical + '/')) throw new CollabError('invalid', 'untracked file leaves worktree'); const bytes = readFileSync(absolute); lines += bytes.toString('utf8').split('\n').length; return `${path}:${hash(bytes)}`; });
  const files = [...gitText(root, ['diff', '--name-only', 'HEAD', '--']).trim().split('\n').filter(Boolean), ...untracked];
  return { root: canonical, head, treeHash: hash(JSON.stringify([head, diff, extra])), changedLines: lines, files };
}
export interface GateResult { ok: boolean; treeHash: string; changedLines: number; checks: { kind: CheckKind; ok: boolean; exitCode: number | null; evidence: string; reason?: string }[]; docGaps: string[]; reason?: string; override?: boolean }
export class CodingGate {
  readonly #db: DatabaseSync; readonly #run: VerifierPort; readonly #audit: (event: object) => void;
  constructor(options: { path: string; verifier?: VerifierPort; audit: (event: object) => void }) {
    this.#db = new DatabaseSync(options.path); if (options.path !== ':memory:' && process.platform !== 'win32') chmodSync(options.path, 0o600); this.#run = options.verifier ?? sandboxVerifier(); this.#audit = options.audit;
    this.#db.exec('CREATE TABLE IF NOT EXISTS coding_reviews(task TEXT, tree_hash TEXT, reviewer TEXT, caller TEXT, PRIMARY KEY(task,tree_hash,reviewer));');
  }
  close() { this.#db.close(); }
  snapshot(root: string) { return worktreeSnapshot(root); }
  recordReview(task: string, snapshot: ReturnType<typeof worktreeSnapshot>, reviewer: string, caller: string): void {
    if (reviewer === caller || this.snapshot(snapshot.root).treeHash !== snapshot.treeHash) throw new CollabError('conflict', 'independent review of current tree required');
    this.#audit({ kind: 'coding.review', task, treeHash: snapshot.treeHash, reviewer, caller });
    this.#db.prepare('INSERT OR REPLACE INTO coding_reviews VALUES (?,?,?,?)').run(task, snapshot.treeHash, reviewer, caller);
  }
  async verify(input: { task: string; root: string; signal: AbortSignal; override?: { note: string; person: string } }): Promise<GateResult> {
    const before = this.snapshot(input.root);
    const docGaps = before.files.some(f => /\.(?:ts|js|py|rs|go|java|kt)$/.test(f)) && !before.files.some(f => /(?:^docs\/|README|\.md$)/.test(f)) ? ['Document changed behavior or explain why no documentation change is needed.'] : [];
    if (input.override) {
      if (!input.override.note.trim() || input.override.note.length > 2000) throw new CollabError('invalid', 'override requires a bounded note');
      this.#audit({ kind: 'coding.override', task: input.task, treeHash: before.treeHash, person: input.override.person, note: input.override.note });
      return { ok: true, treeHash: before.treeHash, changedLines: before.changedLines, checks: [], docGaps, override: true };
    }
    const manifests: Record<string, string> = {};
    for (const file of MANIFESTS) {
      let committed: string | undefined; try { committed = gitText(before.root, ['show', `${before.head}:${file}`]); } catch {}
      const current = existsSync(join(before.root, file)) ? readFileSync(join(before.root, file), 'utf8') : undefined;
      if (current !== committed) return { ok: false, treeHash: before.treeHash, changedLines: before.changedLines, checks: [], docGaps, reason: 'verifier-conventions-changed' };
      if (committed !== undefined) manifests[file] = committed;
    }
    const plan = detectVerifiers(manifests), checks: GateResult['checks'] = [];
    for (const command of plan.commands) {
      input.signal.throwIfAborted();
      const r = await this.#run.run(before.root, command, { signal: input.signal, networkAllowed: plan.networkAllowed });
      checks.push({ kind: command.kind, ok: r.ok, exitCode: r.exitCode, evidence: hash(r.output), ...(r.reason ? { reason: r.reason } : {}) });
    }
    const same = this.snapshot(input.root).treeHash === before.treeHash;
    const review = before.changedLines < 200 || !!this.#db.prepare('SELECT 1 FROM coding_reviews WHERE task=? AND tree_hash=?').get(input.task, before.treeHash);
    const ok = same && review && checks.every(c => c.ok);
    const result: GateResult = { ok, treeHash: before.treeHash, changedLines: before.changedLines, checks, docGaps, ...(!same ? { reason: 'worktree-changed-during-verification' } : !checks.every(c => c.ok) ? { reason: 'verifiers-failed' } : !review ? { reason: 'review-required' } : {}) };
    this.#audit({ kind: 'coding.verified', task: input.task, ...result });
    return result;
  }
}
