import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, existsSync, realpathSync, chmodSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
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
/** Worktree files are untrusted, including special files planted by a terminal. */
function worktreeFile(root: string, name: string): Buffer {
  const path = realpathSync.native(join(root, name));
  if (!path.startsWith(realpathSync.native(root) + sep)) throw new CollabError('invalid', 'file leaves worktree');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink > 1 || stat.size > 16 * 1024 * 1024) throw new CollabError('invalid', 'worktree file must be a bounded regular file without hardlinks');
    const bytes = Buffer.alloc(stat.size + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > stat.size) throw new CollabError('invalid', 'worktree file changed while reading');
    return bytes.subarray(0, count);
  } finally { closeSync(fd); }
}
export function worktreeSnapshot(root: string, git: typeof gitText = gitText): { root: string; treeHash: string; changedLines: number; files: string[]; head: string } {
  // Native resolution on both sides: Git for Windows reports the top level by its long name with `/` separators, while
  // the bound root may be spelled with an 8.3 alias (`C:\Users\RUNNER~1\...`) that only the native call expands.
  const canonical = realpathSync.native(root), top = realpathSync.native(git(root, ['rev-parse', '--show-toplevel']).trim());
  if (canonical !== top) throw new CollabError('invalid', 'verifier requires the bound Git worktree root');
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  // Git diff opens tracked files too. Reject a FIFO/device before invoking it, not only before our own reads.
  const tracked = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  if (tracked.length > 20000) throw new CollabError('invalid', 'worktree file scan exceeds safety cap');
  for (const name of tracked) {
    let stat;
    try { stat = lstatSync(join(root, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if ((!stat.isFile() && !stat.isSymbolicLink()) || (stat.isFile() && (stat.nlink > 1 || stat.size > 16 * 1024 * 1024)))
      throw new CollabError('invalid', 'worktree file must be a bounded regular file without hardlinks');
  }
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const diff = git(root, ['diff', '--binary', 'HEAD', '--']);
  const stats = git(root, ['diff', '--numstat', 'HEAD', '--']).trim().split('\n').filter(Boolean);
  let lines = stats.reduce((n, line) => { const [a, d] = line.split('\t'); return n + (a === '-' || d === '-' ? 200 : Number(a) + Number(d)); }, 0);
  const extra = untracked.map(path => { const bytes = worktreeFile(root, path); lines += bytes.toString('utf8').split('\n').length; return `${path}:${hash(bytes)}`; });
  const files = [...git(root, ['diff', '--name-only', 'HEAD', '--']).trim().split('\n').filter(Boolean), ...untracked];
  return { root: canonical, head, treeHash: hash(JSON.stringify([head, diff, extra])), changedLines: lines, files };
}
export interface GateResult { ok: boolean; treeHash: string; changedLines: number; checks: { kind: CheckKind; ok: boolean; exitCode: number | null; evidence: string; reason?: string }[]; docGaps: string[]; reason?: string; override?: boolean }
export class CodingGate {
  readonly #git: typeof gitText;
  readonly #db: DatabaseSync; readonly #run: VerifierPort; readonly #audit: (event: object) => void;
  constructor(options: { path: string; verifier?: VerifierPort; audit: (event: object) => void; git?: typeof gitText }) {
    this.#git = options.git ?? gitText;
    this.#db = new DatabaseSync(options.path); if (options.path !== ':memory:' && process.platform !== 'win32') chmodSync(options.path, 0o600); this.#run = options.verifier ?? sandboxVerifier(); this.#audit = options.audit;
    this.#db.exec('CREATE TABLE IF NOT EXISTS coding_reviews(task TEXT, tree_hash TEXT, reviewer TEXT, caller TEXT, PRIMARY KEY(task,tree_hash,reviewer));');
  }
  close() { this.#db.close(); }
  snapshot(root: string) { return worktreeSnapshot(root, this.#git); }
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
      let committed: string | undefined; try { committed = this.#git(before.root, ['show', `${before.head}:${file}`]); } catch {}
      const current = existsSync(join(before.root, file)) ? worktreeFile(before.root, file).toString('utf8') : undefined;
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
