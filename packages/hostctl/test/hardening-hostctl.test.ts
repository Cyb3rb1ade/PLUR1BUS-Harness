// Step 10 of the server hardening sweep: files, search, atomic writes and processes of hostctl, against real files and real
// child processes in throw-away directories (no network, no shell). Generative cases use mulberry32 with a fixed seed that
// appears in every failure message. A "KNOWN GAP" would be an `it.todo` plus an `it.fails` that holds the evidence; all three
// gaps of the first sweep are closed and are ordinary tests now.
// Already pinned elsewhere (not repeated): the fake-spawn process contract, ownership, the 33rd process, shell gating,
// dangerous-command refusals, env allowlist by example, atomic create/overwrite/abort/CHANGED, NUL and traversal by example,
// native argv contracts (processes.coverage, atomic.coverage, files.coverage, hostctl.test, native*.test).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from '../src/atomic.ts';
import { configure } from '../src/config.ts';
import { files } from '../src/files.ts';
import { createHostctl, type Hostctl, type Options, type RunContext } from '../src/index.ts';
import { textMatcher } from '../src/search.ts';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const posix = process.platform !== 'win32';
const root0 = await realpath(tmpdir());
const ctx: RunContext = { agentId: 'fixture-agent', principal: 'fixture-owner', sessionId: 's1', signal: new AbortController().signal };

let root: string, outside: string, home: string; const hosts: Hostctl[] = [];
beforeEach(async () => { root = await realpath(await mkdtemp(join(root0, 'hc-root-'))); outside = await realpath(await mkdtemp(join(root0, 'hc-out-'))); home = await realpath(await mkdtemp(join(root0, 'hc-home-'))); });
afterEach(async () => { for (const h of hosts.splice(0)) await h.close(); for (const d of [root, outside, home]) await rm(d, { recursive: true, force: true }); });
const make = (o: Partial<Options> = {}): Hostctl => { const h = createHostctl({ home, baseEnv: {}, roots: [{ id: 'fixture', path: root }], audit: () => {}, ...o }); hosts.push(h); return h; };
const call = (h: Hostctl, name: string, args: object = {}, c: RunContext = ctx) => h.invoke(`hostctl.${name}`, args, c) as Promise<{ ok: boolean; value?: any; error?: { code: string; hint: string } }>;
const node = (script: string, extra: string[] = []) => ({ program: process.execPath, args: ['-e', script, ...extra] });
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await sleep(25); } return false; }

// ---- processes: real children -----------------------------------------------------------------------------------------

describe('arguments are never interpreted by a shell', () => {
  it('shell metacharacters, command substitutions and "; rm -rf" reach the program as literal argv, and nothing they spell is executed', async () => {
    const h = make({ config: { exec: { timeoutMs: 20000 } } }); const evil = ['; rm -rf', '$(touch pwned-1)', '`touch pwned-2`', '&& touch pwned-3', '| touch pwned-4', '> pwned-5', 'a\ntouch pwned-6', '*', '~', '$HOME', '${IFS}x', "'; touch pwned-7; '", '"; touch pwned-8; "', '--', '-e', 'é€😀', ''];
    const r = await call(h, 'proc.exec', { ...node('process.stdout.write(JSON.stringify(process.argv.slice(1)))', evil), cwd: root });
    expect(r.ok, JSON.stringify(r)).toBe(true); expect(JSON.parse(r.value.output)).toEqual(evil); expect(r.value.exitCode).toBe(0);
    expect((await readdir(root)).filter(n => n.startsWith('pwned'))).toEqual([]);
    const marker = await call(h, 'proc.exec', { ...node('require("fs").writeFileSync(process.argv[1], "ran")', [join(root, 'target.txt')]), cwd: root }); expect(marker.ok).toBe(true);
    expect(await readFile(join(root, 'target.txt'), 'utf8')).toBe('ran');
  });

  it('an interpreter named in program is refused for exec (it needs proc.shell, which is off), however it is spelled', async () => {
    const h = make();
    for (const program of ['bash', '/bin/bash', 'zsh', 'sh', '/bin/sh', 'dash', 'fish', 'pwsh', 'powershell', 'cmd', 'cmd.exe', 'BASH', '/usr/bin/ZSH', 'pwsh.exe']) { const r = await call(h, 'proc.exec', { program, args: ['-c', 'echo hi'], cwd: root }); expect(r.ok, program).toBe(false); expect(r.error!.code, program).toBe('DENIED'); }
    expect((await call(h, 'proc.shell', { command: 'echo hi', cwd: root })).error!.code).toBe('DENIED');
  });
});

describe('time, output and environment of real children', () => {
  it('a process that outlives its time limit is a TIMEOUT, is gone afterwards, and does not hold the call for its own lifetime', async () => {
    const h = make({ config: { exec: { timeoutMs: 400 } } }); const t0 = Date.now();
    const r = await call(h, 'proc.exec', { ...node('console.log(process.pid); setInterval(() => {}, 1000)'), cwd: root });
    expect(r.ok).toBe(false); expect(r.error!.code).toBe('TIMEOUT'); expect(Date.now() - t0).toBeLessThan(8000);
    const list = await call(h, 'proc.list'); const job = list.value.processes[0]; expect(job.timedOut).toBe(true); expect(job.running).toBe(false);
    const pid = Number(job.output.split('\n')[0]); expect(Number.isInteger(pid)).toBe(true); expect(await until(() => !alive(pid), 5000)).toBe(true);
    const shorter = await call(h, 'proc.exec', { ...node('setInterval(() => {}, 1000)'), cwd: root, timeoutMs: 100 }); expect(shorter.error!.code).toBe('TIMEOUT');
    for (const bad of [0, -1, 1.5, 300001, 'x', NaN, Infinity, null]) expect((await call(h, 'proc.exec', { ...node('1'), cwd: root, timeoutMs: bad as never })).error!.code, String(bad)).toBe('INVALID_ARGUMENT');
  }, 30_000);

  it('output is bounded: five megabytes of stdout and stderr keep a prefix and the marker, the child still runs to the end, and nothing else is retained', async () => {
    const h = make({ config: { output: { maxBytes: 2048 }, exec: { timeoutMs: 30000 } } });
    const r = await call(h, 'proc.exec', { ...node('const big = "x".repeat(65536); for (let i = 0; i < 40; i++) { process.stdout.write(big); process.stderr.write(big); } process.stdout.write("END")'), cwd: root });
    expect(r.ok, JSON.stringify(r).slice(0, 200)).toBe(true); expect(r.value.exitCode).toBe(0); expect(r.value.truncated).toBe(true);
    expect(Buffer.byteLength(r.value.output)).toBeLessThanOrEqual(2048 + '\n[OUTPUT TRUNCATED]'.length); expect(r.value.output.endsWith('[OUTPUT TRUNCATED]')).toBe(true); expect(r.value.output).not.toContain('END');
    const again = await call(h, 'proc.read_output', { id: r.value.id }); expect(Buffer.byteLength(again.value.output)).toBeLessThanOrEqual(2048 + 19);
  }, 60_000);

  it('the child gets only allowlisted variables that exist; blocked names stay out even when the operator allowlists them; a request cannot add a name that is not allowed', async () => {
    const base = { PATH: process.env.PATH ?? '/usr/bin', HOME: '/home/someone', SECRET_TOKEN: 'redact-probe-alpha', MY_API_PASSWORD: 'redact-probe-alpha', AWS_SECRET_ACCESS_KEY: 'redact-probe-alpha', LD_PRELOAD: '/tmp/evil.so', NODE_OPTIONS: '--require /tmp/evil.js', PYTHONPATH: '/tmp/evil', BASH_ENV: '/tmp/evil.sh', ENV: '/tmp/e', LANG: 'C', MY_VAR: 'visible', UNLISTED: 'x' };
    const h = make({ baseEnv: base, config: { env: { allow: ['PATH', 'LANG', 'MY_VAR', 'SECRET_TOKEN', 'MY_API_PASSWORD', 'LD_PRELOAD', 'NODE_OPTIONS', 'PYTHONPATH', 'BASH_ENV', 'ENV', 'ABSENT_VAR'] }, exec: { timeoutMs: 20000 } } });
    const r = await call(h, 'proc.exec', { ...node('process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))'), cwd: root }); expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(JSON.parse(r.value.output).filter((k: string) => !k.startsWith('__CF'))).toEqual(['LANG', 'MY_VAR', 'PATH']); // macOS adds __CF_USER_TEXT_ENCODING to every process it starts
    const given = await call(h, 'proc.exec', { ...node('process.stdout.write(process.env.MY_VAR + "|" + process.env.LANG)'), cwd: root, env: { MY_VAR: 'from-request' } }); expect(given.value.output).toBe('from-request|C');
    for (const key of ['UNLISTED', 'HOME', 'SECRET_TOKEN', 'LD_PRELOAD', 'NODE_OPTIONS', '__proto__', 'constructor', 'path', 'My_Var']) { const d = await call(h, 'proc.exec', { ...node('1'), cwd: root, env: { [key]: 'x' } }); expect(d.ok, key).toBe(false); expect(d.error!.code, key).toBe('DENIED'); }
    for (const value of [5, null, {}, ['x'], true]) expect((await call(h, 'proc.exec', { ...node('1'), cwd: root, env: { MY_VAR: value } })).error!.code).toBe('INVALID_ARGUMENT');
    for (const env of [[], 'x', 5, null]) expect((await call(h, 'proc.exec', { ...node('1'), cwd: root, env: env as never })).error!.code).toBe('INVALID_ARGUMENT');
  }, 60_000);
});

describe('the whole process tree ends, not just its leader', () => {
  const tree = 'const { spawn } = require("child_process"); const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log("child " + process.pid + " grandchild " + g.pid); setInterval(() => {}, 1000)';
  const pids = (out: string) => { const m = /child (\d+) grandchild (\d+)/.exec(out); return m ? [Number(m[1]), Number(m[2])] as const : undefined; };

  it.skipIf(!posix)('kill ends the leader and its descendant; so do the time limit and ending the session', async () => {
    const h = make({ config: { exec: { timeoutMs: 20000 } } });
    for (const how of ['kill', 'session'] as const) {
      const s = await call(h, 'proc.start', { ...node(tree), cwd: root }); expect(s.ok).toBe(true);
      expect(await until(async () => pids((await call(h, 'proc.read_output', { id: s.value.id })).value.output) !== undefined, 8000)).toBe(true);
      const [leader, grandchild] = pids((await call(h, 'proc.read_output', { id: s.value.id })).value.output)!; expect(alive(leader) && alive(grandchild)).toBe(true);
      if (how === 'kill') await call(h, 'proc.kill', { id: s.value.id }); else await h.endSession('s1');
      expect(await until(() => !alive(leader) && !alive(grandchild), 8000), `${how}: leader ${alive(leader)} grandchild ${alive(grandchild)}`).toBe(true);
    }
    const t = make({ config: { exec: { timeoutMs: 600 } } }); const timed = await call(t, 'proc.exec', { ...node(tree), cwd: root }); expect(timed.error!.code).toBe('TIMEOUT');
    const out = (await call(t, 'proc.list')).value.processes[0].output; const [l2, g2] = pids(out)!; expect(await until(() => !alive(l2) && !alive(g2), 8000)).toBe(true);
  }, 60_000);

  it.skipIf(!posix)('when the leader exits on its own, a descendant it left behind in the group is reaped too', async () => {
    const h = make({ config: { exec: { timeoutMs: 20000 } } });
    const r = await call(h, 'proc.exec', { ...node('const { spawn } = require("child_process"); const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log("grandchild " + g.pid); setTimeout(() => process.exit(0), 300)'), cwd: root });
    expect(r.ok, JSON.stringify(r)).toBe(true); const pid = Number(/grandchild (\d+)/.exec(r.value.output)![1]); expect(await until(() => !alive(pid), 8000)).toBe(true);
  }, 30_000);
});

describe('a process that does not read its input cannot make the host buffer without bound', () => {
  it('stdin written to a child that never reads is refused once more than one output-limit of it is waiting', async () => {
    const h = make({ config: { output: { maxBytes: 65536 }, exec: { timeoutMs: 20000 } } });
    const s = await call(h, 'proc.start', { ...node('setInterval(() => {}, 1000)'), cwd: root }); expect(s.ok).toBe(true); const block = 'x'.repeat(60_000);
    let accepted = 0; let firstRefusal: string | undefined;
    for (let i = 0; i < 200 && firstRefusal === undefined; i++) { const r = await call(h, 'proc.write_stdin', { id: s.value.id, text: block }); if (r.ok) accepted += r.value.written; else firstRefusal = r.error!.code; }
    expect(firstRefusal, `${accepted} bytes were accepted for a child that reads nothing`).toBe('TOO_LARGE'); expect(accepted).toBeLessThanOrEqual(65536 * 8);
    await call(h, 'proc.kill', { id: s.value.id });
  }, 60_000);
});

// ---- processes and credentials: former KNOWN GAPs, now closed ------------------------------------------------------------------------------------------------

describe('environment names that inject code stay blocked even when allowlisted', () => {
  const inject = ['PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB', 'PYTHONSTARTUP', 'PYTHONHOME', 'NODE_PATH', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH', 'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF', 'LESSOPEN', 'PROMPT_COMMAND', 'GCONV_PATH'];
  it('an operator who allowlists a code-injecting variable does not hand it to the child', async () => {
    const base = Object.fromEntries(inject.map(k => [k, 'redact-probe-alpha'])); const h = make({ baseEnv: base, config: { env: { allow: inject }, exec: { timeoutMs: 20000 } } });
    const r = await call(h, 'proc.exec', { ...node('process.stdout.write(JSON.stringify(Object.keys(process.env)))'), cwd: root }); expect(r.ok).toBe(true);
    expect(JSON.parse(r.value.output).filter((k: string) => !k.startsWith('__CF'))).toEqual([]);
  }, 30_000);
});

describe('foreign termination cannot target the supervisor or the own process group', () => {
  it('the parent process id is refused as a foreign pid', async () => {
    const signalled: number[] = []; const h = make({ killForeign: pid => { signalled.push(pid); } });
    const r = await call(h, 'proc.kill_foreign', { pid: process.ppid }); expect(r.ok).toBe(false); expect(r.error!.code).toBe('DENIED'); expect(signalled).toEqual([]);
  });
  it.skipIf(process.platform !== 'linux')('the leader pid of the own process group is refused, an unrelated pid still passes through', async () => {
    const stat = (await readFile('/proc/self/stat', 'utf8')); const pgid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
    const signalled: number[] = []; const h = make({ killForeign: pid => { signalled.push(pid); } });
    const r = await call(h, 'proc.kill_foreign', { pid: pgid }); expect(r.ok).toBe(false); expect(r.error!.code).toBe('DENIED'); expect(signalled).toEqual([]);
    const free = 2 ** 22 + 12345; expect((await call(h, 'proc.kill_foreign', { pid: free })).ok).toBe(true); expect(signalled).toEqual([free]);
  });
});

describe('the harness\'s own credential files are on the default deny list', () => {
  it('the three token files under run/ are neither readable nor searchable', async () => {
    await mkdir(join(root, 'run')); for (const n of ['api-owner.token', 'core.token', 'supervisor.token']) await writeFile(join(root, 'run', n), 'redact-probe-alpha-token-file');
    const h = make();
    for (const n of ['api-owner.token', 'core.token', 'supervisor.token']) { const r = await call(h, 'fs.read', { path: `run/${n}` }); expect(r.ok, `${n} was read`).toBe(false); expect(r.error!.code).toBe('DENIED'); }
    const found = await call(h, 'fs.search', { path: '.', query: 'redact-probe-alpha-token-file', mode: 'content' }); expect(found.value.matches).toEqual([]);
  });
});

// ---- atomic writes ------------------------------------------------------------------------------------------------------

describe('atomic writes keep what must stay', () => {
  it.skipIf(!posix)('permissions of an existing file survive write, append and edit; a new file is private; no temporary file is left', async () => {
    const h = make(); await writeFile(join(root, 'run.sh'), 'echo old\n'); await chmod(join(root, 'run.sh'), 0o755); await writeFile(join(root, 'shared.txt'), 'a\n'); await chmod(join(root, 'shared.txt'), 0o640);
    expect((await call(h, 'fs.write', { path: 'run.sh', content: 'echo new\n' })).ok).toBe(true); expect((await call(h, 'fs.append', { path: 'shared.txt', content: 'b\n' })).ok).toBe(true); expect((await call(h, 'fs.edit', { path: 'shared.txt', oldText: 'a', newText: 'z' })).ok).toBe(true);
    expect((await stat(join(root, 'run.sh'))).mode & 0o777).toBe(0o755); expect((await stat(join(root, 'shared.txt'))).mode & 0o777).toBe(0o640); expect(await readFile(join(root, 'shared.txt'), 'utf8')).toBe('z\nb\n');
    expect((await call(h, 'fs.write', { path: 'fresh.txt', content: 'x' })).ok).toBe(true); expect((await stat(join(root, 'fresh.txt'))).mode & 0o777).toBe(0o600);
    expect((await readdir(root)).filter(n => n.includes('.hostctl-') || n.endsWith('.tmp'))).toEqual([]);
  });

  it('twenty writers at one file at once: the result is exactly one writer\'s content, every call is ok or CHANGED, and nothing is left behind', async () => {
    const h = make(); await writeFile(join(root, 'race.txt'), 'original'); const contents = Array.from({ length: 20 }, (_, i) => `writer-${i}-${'x'.repeat(2000 + i)}`);
    const results = await Promise.all(contents.map(content => call(h, 'fs.write', { path: 'race.txt', content })));
    for (const r of results) expect(r.ok || r.error!.code === 'CHANGED', JSON.stringify(r)).toBe(true);
    const final = await readFile(join(root, 'race.txt'), 'utf8'); expect(contents).toContain(final); expect(results.filter(r => r.ok).length).toBeGreaterThan(0);
    expect((await readdir(root)).filter(n => n !== 'race.txt')).toEqual([]);
  });

  it('a megabyte survives intact, and one byte over the limit writes nothing', async () => {
    const h = make({ config: { output: { maxBytes: 1_048_576 } } }); const data = Buffer.alloc(1_048_576); for (let i = 0; i < data.length; i++) data[i] = 0x61 + (i % 26);
    expect((await call(h, 'fs.write', { path: 'big.txt', content: data.toString() })).ok).toBe(true); expect(createHash('sha256').update(await readFile(join(root, 'big.txt'))).digest('hex')).toBe(createHash('sha256').update(data).digest('hex'));
    const over = await call(h, 'fs.write', { path: 'over.txt', content: data.toString() + 'x' }); expect(over.error!.code).toBe('TOO_LARGE'); expect(existsSync(join(root, 'over.txt'))).toBe(false);
  });

  it.skipIf(!posix)('a crash between the temporary file and the rename (SIGKILL) leaves the original byte for byte, a complete staged copy beside it, and the next write works', async () => {
    const target = join(root, 'precious.txt'); const original = Buffer.from('precious original content\n'.repeat(500)); await writeFile(target, original); await chmod(target, 0o640);
    const script = join(root, '..', `crash-${process.pid}.ts`); const src = (p: string) => JSON.stringify(new URL(`../src/${p}`, import.meta.url).pathname);
    await writeFile(script, `import { atomicWrite } from ${src('atomic.ts')}; import { files } from ${src('files.ts')}; import { configure } from ${src('config.ts')};
      const canon = files([{ id: 'r', path: ${JSON.stringify(root)} }], [], configure(), async () => {}, ${JSON.stringify(home)}, {}).canon;
      await atomicWrite('precious.txt', Buffer.from('NEW CONTENT '.repeat(1000)), true, canon, new AbortController().signal, 65536, async () => { process.kill(process.pid, 'SIGKILL'); });`);
    try {
      const code = await new Promise<number | null>((resolve, reject) => { const c = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', '--conditions=source', script], { stdio: ['ignore', 'ignore', 'pipe'] }); let err = ''; c.stderr.on('data', d => { err += d; }); c.on('error', reject); c.on('close', (c2, sig) => resolve(sig === 'SIGKILL' ? -9 : c2 === 0 ? 0 : (console.error(err), c2))); });
      expect(code, 'the child was killed between staging and rename').toBe(-9);
    } finally { await rm(script, { force: true }); }
    expect(await readFile(target)).toEqual(original); expect((await stat(target)).mode & 0o777).toBe(0o640);
    const stale = (await readdir(root)).filter(n => /^\.hostctl-.*\.tmp$/.test(n)); expect(stale.length, 'at most the one staged copy').toBeLessThanOrEqual(1);
    for (const n of stale) { expect(await readFile(join(root, n), 'utf8')).toBe('NEW CONTENT '.repeat(1000)); expect((await stat(join(root, n))).mode & 0o777).toBe(0o640); }
    const h = make(); expect((await call(h, 'fs.write', { path: 'precious.txt', content: 'after the crash' })).ok).toBe(true); expect(await readFile(target, 'utf8')).toBe('after the crash');
  }, 60_000);

  it.skipIf(!posix || (process.getuid?.() ?? 1) === 0)('when the rename fails after staging (the directory became read-only) the original is untouched and the failure is reported, not hidden', async () => {
    const dir = join(root, 'sub'); await mkdir(dir); await writeFile(join(dir, 'a.txt'), 'original'); const canon = files([{ id: 'r', path: root }], [], configure(), async () => {}, home, {}).canon;
    let code: string | undefined; try { await atomicWrite('sub/a.txt', Buffer.from('new'), true, canon, new AbortController().signal, 65536, async () => { await chmod(dir, 0o500); }); } catch (e) { code = (e as { code?: string }).code ?? (e as Error).name; } finally { await chmod(dir, 0o700); }
    expect(code).toBeDefined(); expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('original');
  });
});

// ---- files: confinement -------------------------------------------------------------------------------------------------

describe('nothing a path can spell reaches outside the root', () => {
  it('2000 generated paths (seeded) over every file operation: no byte of the outside file is returned, nothing outside changes, every answer is a typed result', async () => {
    const SEED = 0xF11E5; const rand = mulberry32(SEED); const SECRET = 'redact-probe-alpha-OUTSIDE';
    await writeFile(join(outside, 'secret.txt'), SECRET); await mkdir(join(outside, 'dir')); await writeFile(join(outside, 'dir', 'inner.txt'), SECRET); await writeFile(join(root, 'inside.txt'), 'inside'); await mkdir(join(root, 'sub'));
    if (posix) { await symlink(join(outside, 'secret.txt'), join(root, 'link-file')); await symlink(join(outside, 'dir'), join(root, 'link-dir')); await symlink('../', join(root, 'sub', 'up')); await symlink(outside, join(root, 'sub', 'abs-up')); }
    const snapshot = async () => JSON.stringify(await Promise.all((await readdir(outside, { recursive: true })).sort().map(async n => [n, (await stat(join(outside, n))).isDirectory() ? 'd' : await readFile(join(outside, n), 'utf8')])));
    const before = await snapshot(); const h = make({ trash: async () => {} });
    const pieces = ['..', '.', '...', '%2e%2e', '%2e', '\\', '/', '//', '\\\\', 'C:', 'C:\\', '\\\\?\\', '\\\\.\\', '\\\\server\\share', 'CON', 'NUL', 'aux.txt', 'inside.txt::$DATA', 'inside.txt:stream', 'trailing.', 'trailing ', '\u202e', '\u2025', '\uff0e\uff0e', '.env', '.ENV.local', 'link-file', 'link-dir', 'sub', 'up', 'abs-up', 'inside.txt', 'secret.txt', 'dir', 'inner.txt', '~', '$HOME', 'file:', '\u0000', 'a'.repeat(300), outside, join(outside, 'secret.txt'), root, join(root, '..')];
    const ops = ['fs.read', 'fs.stat', 'fs.list', 'fs.search', 'fs.write', 'fs.append', 'fs.edit', 'fs.mkdir', 'fs.copy', 'fs.move', 'fs.trash'] as const; const allowed = new Set(['OUTSIDE_ROOT', 'DENIED', 'INVALID_ARGUMENT', 'NOT_FOUND', 'IO_ERROR', 'EXISTS', 'BINARY', 'TOO_LARGE', 'NOT_UNIQUE', 'CHANGED']);
    let refused = 0; let succeeded = 0;
    for (let i = 0; i < 2000; i++) {
      const n = 1 + Math.floor(rand() * 5); let p = ''; for (let k = 0; k < n; k++) p += pieces[Math.floor(rand() * pieces.length)]! + (rand() < 0.5 ? '/' : '');
      const op = ops[Math.floor(rand() * ops.length)]!; const args: Record<string, unknown> = { path: p, ...(op === 'fs.write' || op === 'fs.append' ? { content: 'redact-probe-alpha-written' } : {}), ...(op === 'fs.edit' ? { oldText: 'inside', newText: 'redact-probe-alpha-written' } : {}), ...(op === 'fs.search' ? { query: 'e', mode: rand() < 0.5 ? 'content' : 'name' } : {}), ...(op === 'fs.copy' || op === 'fs.move' ? { destination: pieces[Math.floor(rand() * pieces.length)]! + pieces[Math.floor(rand() * pieces.length)]! } : {}) };
      let r; try { r = await call(h, op, args); } catch (e) { throw new Error(`seed ${SEED} case ${i}: ${op} ${JSON.stringify(args)} threw ${(e as Error).message}`); }
      const where = `seed ${SEED} case ${i}: ${op} ${JSON.stringify(args).slice(0, 160)} → ${JSON.stringify(r).slice(0, 200)}`;
      if (r.ok) { succeeded++; expect(JSON.stringify(r.value), where).not.toContain(SECRET); } else { refused++; expect(allowed.has(r.error!.code), where).toBe(true); expect(JSON.stringify(r.error), where).not.toContain(SECRET); }
      if (i % 250 === 0) expect(await snapshot(), `${where}: the outside tree changed`).toBe(before);
      if (op === 'fs.move' || op === 'fs.trash') { await writeFile(join(root, 'inside.txt'), 'inside').catch(() => {}); }
    }
    expect(await snapshot()).toBe(before); expect(refused).toBeGreaterThan(1000); expect(succeeded, `seed ${SEED}: some inside paths must succeed, or the property is vacuous`).toBeGreaterThan(20);
  }, 120_000);

  it('Windows-shaped paths (drive, UNC, device, stream, reserved name) are refused or are plain names inside the root; they never name something else', async () => {
    const h = make(); await writeFile(join(outside, 'win.ini'), 'redact-probe-alpha-OUTSIDE');
    for (const p of ['C:\\Windows\\win.ini', 'c:/windows/win.ini', '\\\\server\\share\\x', '//server/share/x', '\\\\?\\C:\\Windows', '\\\\.\\pipe\\x', '\\\\.\\COM1', '..\\..\\win.ini', `..\\${outside}`, 'CON', 'NUL', 'COM1', 'LPT1', 'aux.txt', 'note.txt::$DATA', 'note.txt:hidden', 'trail.', 'trail ']) {
      const r = await call(h, 'fs.read', { path: p }); expect(r.ok && JSON.stringify(r.value).includes('OUTSIDE'), p).toBe(false);
      if (/^(\\\\|\/\/|\.\.)/.test(p)) { expect(r.ok, p).toBe(false); expect(['OUTSIDE_ROOT', 'DENIED'], p).toContain(r.error!.code); }
      const w = await call(h, 'fs.write', { path: p, content: 'x' }); if (w.ok) expect((await readdir(outside)).sort(), `${p} wrote outside the root`).toEqual(['win.ini']);
    }
  });

  it.skipIf(!posix)('links that leave the root are refused whatever the operation, links inside are fine, and a link swapped in after the check does not let a write through', async () => {
    const h = make(); await writeFile(join(outside, 'target.txt'), 'redact-probe-alpha-OUTSIDE'); await mkdir(join(root, 'real')); await writeFile(join(root, 'real', 'f.txt'), 'inside');
    await symlink(join(outside, 'target.txt'), join(root, 'out-file')); await symlink(outside, join(root, 'out-dir')); await symlink(join(root, 'real'), join(root, 'in-dir')); await symlink(join(root, 'real', 'f.txt'), join(root, 'in-file'));
    for (const p of ['out-file', 'out-dir', 'out-dir/target.txt', 'out-dir/new.txt']) for (const op of ['fs.read', 'fs.stat', 'fs.write', 'fs.append', 'fs.edit', 'fs.mkdir', 'fs.list', 'fs.copy', 'fs.move', 'fs.trash']) { const r = await call(h, op, { path: p, content: 'x', oldText: 'a', newText: 'b', destination: 'moved.txt' }); expect(r.ok, `${op} ${p}`).toBe(false); }
    expect(await readFile(join(outside, 'target.txt'), 'utf8')).toBe('redact-probe-alpha-OUTSIDE'); expect(await readdir(outside)).toEqual(['target.txt']);
    expect((await call(h, 'fs.read', { path: 'in-file' })).value.content).toBe('inside'); expect((await call(h, 'fs.read', { path: 'in-dir/f.txt' })).value.content).toBe('inside');
    const swap = make({ afterStage: async () => { await rm(join(root, 'real'), { recursive: true }); await symlink(outside, join(root, 'real')); } });
    const r = await call(swap, 'fs.write', { path: 'real/f.txt', content: 'redact-probe-alpha-written' }); expect(r.ok).toBe(false); expect(await readdir(outside)).toEqual(['target.txt']);
  });
});

describe('listing and search are bounded', () => {
  it('a directory of 3000 files lists at most the limit and says it is truncated; a tree 20 deep stops at 16; entries come back sorted and unique', async () => {
    const h = make(); await mkdir(join(root, 'wide')); await Promise.all(Array.from({ length: 3000 }, (_, i) => writeFile(join(root, 'wide', `f${String(i).padStart(4, '0')}.txt`), 'x')));
    const r = await call(h, 'fs.list', { path: 'wide', limit: 1000 }); expect(r.ok).toBe(true); expect(r.value.entries.length).toBeLessThanOrEqual(1000); expect(r.value.truncated).toBe(true);
    expect(new Set(r.value.entries.map((e: { path: string }) => e.path)).size).toBe(r.value.entries.length);
    let dir = join(root, 'deep'); for (let i = 0; i < 20; i++) { await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'f.txt'), 'x'); dir = join(dir, `d${i}`); }
    const deep = await call(h, 'fs.list', { path: 'deep', depth: 16, limit: 1000 }); expect(deep.ok).toBe(true); expect(Math.max(...deep.value.entries.map((e: { path: string }) => e.path.split('/').length))).toBeLessThanOrEqual(17);
    expect((await call(h, 'fs.list', { path: 'deep', depth: 17 })).error!.code).toBe('INVALID_ARGUMENT'); expect((await call(h, 'fs.list', { path: 'wide', limit: 1001 })).error!.code).toBe('INVALID_ARGUMENT');
  }, 60_000);

  it('content search over 1500 matching files returns at most the configured results, says it is truncated, and finishes in bounded time; a 3 GB sparse file is skipped, never read', async () => {
    const h = make({ config: { search: { maxResults: 100 } } }); await mkdir(join(root, 'many')); await Promise.all(Array.from({ length: 1500 }, (_, i) => writeFile(join(root, 'many', `n${i}.txt`), `needle ${i}`)));
    await writeFile(join(root, 'huge.bin'), ''); await truncate(join(root, 'huge.bin'), 3 * 1024 ** 3);
    const t0 = Date.now(); const r = await call(h, 'fs.search', { path: '.', query: 'needle', mode: 'content', depth: 4, limit: 100 });
    expect(r.ok, JSON.stringify(r).slice(0, 200)).toBe(true); expect(r.value.matches.length).toBe(100); expect(r.value.truncated).toBe(true); expect(Date.now() - t0).toBeLessThan(30_000);
    expect((await call(h, 'fs.read', { path: 'huge.bin' })).error!.code).toBe('TOO_LARGE'); expect((await call(h, 'fs.append', { path: 'huge.bin', content: 'x' })).error!.code).toBe('TOO_LARGE'); expect((await call(h, 'fs.edit', { path: 'huge.bin', oldText: 'a', newText: 'b' })).error!.code).toBe('TOO_LARGE');
    expect((await call(h, 'fs.search', { path: '.', query: 'needle', limit: 1001 })).error!.code).toBe('INVALID_ARGUMENT');
  }, 120_000);
});

describe('search matches the way the documentation says, with or without ripgrep', () => {
  it('400 seeded text/query pairs: the matcher agrees with a plain literal substring test, including queries that look like options, patterns or several lines', async () => {
    const SEED = 0x5EA2C4; const rand = mulberry32(SEED); const m = await textMatcher(); const sig = new AbortController().signal;
    const atoms = ['alpha', 'Beta', '--version', '-e', '--pre=x', '.', '*', '+', '?', '[a-z]', '(x|y)', '^', '$', '\\', '\\d', ' ', '\t', 'é', '€', '😀', '\n', '\r\n', '\r', 'a.b', 'a\\.b', '--', '-', '#', '/', "'", '"', '|', '{1,3}'];
    const gen = (n: number) => Array.from({ length: n }, () => atoms[Math.floor(rand() * atoms.length)]!).join('');
    let lines = 0;
    for (let i = 0; i < 400; i++) {
      const text = gen(2 + Math.floor(rand() * 20)); const cps = Array.from(text); /* by code point: the tool surface refuses ill-formed strings before they reach the matcher */ const q = rand() < 0.5 ? cps.slice(Math.floor(rand() * 3), Math.floor(rand() * cps.length) + 1).join('') : gen(1 + Math.floor(rand() * 4)); if (q === '') continue;
      if (/[\r\n]/.test(q)) lines++;
      expect(await m.matches(text, q, sig), `seed ${SEED} case ${i} (${m.backend}): ${JSON.stringify({ text, q })}`).toBe(text.includes(q));
    }
    expect(lines, `seed ${SEED}: queries with line breaks were exercised`).toBeGreaterThan(5);
    for (const [text, q] of [['alpha\nbeta', 'alpha\nbeta'], ['alpha\r\nbeta', 'alpha\r\nbeta'], ['x\ny', 'x\n'], ['a\rb', 'a\rb']] as const) expect(await m.matches(text, q, sig), JSON.stringify([text, q])).toBe(true);
  }, 120_000);
});

describe('edit is a literal, unique replacement and keeps everything else', () => {
  it('$-patterns in the new text are literal; an overlapping needle is not unique; empty replacement, BOM, CRLF and Unicode are preserved byte for byte', async () => {
    const h = make(); const put = (n: string, c: string | Buffer) => writeFile(join(root, n), c);
    await put('p.txt', 'price: X'); for (const newText of ['$&', '$1', '$$', '$`', "$'", '$<n>', '\\1', '$&$&']) { await call(h, 'fs.write', { path: 'p.txt', content: 'price: X' }); expect((await call(h, 'fs.edit', { path: 'p.txt', oldText: 'X', newText })).ok).toBe(true); expect(await readFile(join(root, 'p.txt'), 'utf8')).toBe(`price: ${newText}`); }
    await put('o.txt', 'aaa'); expect((await call(h, 'fs.edit', { path: 'o.txt', oldText: 'aa', newText: 'b' })).error!.code).toBe('NOT_UNIQUE'); expect(await readFile(join(root, 'o.txt'), 'utf8')).toBe('aaa');
    await put('e.txt', 'keep [drop] keep'); expect((await call(h, 'fs.edit', { path: 'e.txt', oldText: '[drop] ', newText: '' })).ok).toBe(true); expect(await readFile(join(root, 'e.txt'), 'utf8')).toBe('keep keep');
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('line1\r\nline2 € 😀\r\nline3\r\n')]); await put('b.txt', bom); expect((await call(h, 'fs.edit', { path: 'b.txt', oldText: 'line2', newText: 'LINE2' })).ok).toBe(true);
    expect(await readFile(join(root, 'b.txt'))).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('line1\r\nLINE2 € 😀\r\nline3\r\n')]));
    await put('bin.dat', Buffer.from([0x61, 0xff, 0xfe, 0x62])); expect((await call(h, 'fs.edit', { path: 'bin.dat', oldText: 'a', newText: 'z' })).error!.code).toBe('BINARY'); expect(await readFile(join(root, 'bin.dat'))).toEqual(Buffer.from([0x61, 0xff, 0xfe, 0x62]));
    for (const oldText of ['', 'missing']) expect((await call(h, 'fs.edit', { path: 'e.txt', oldText, newText: 'x' })).ok).toBe(false);
  });
});

describe('configuration cannot be made to mean nothing', () => {
  it('a number that is NaN, infinite, negative or not a number at all falls back to the default or the nearest bound; a list that is not a list is the default', () => {
    for (const bad of [NaN, Infinity, -Infinity, -5, 0, '12', null, undefined, {}, [], true]) {
      const c = configure({ exec: { timeoutMs: bad as never }, output: { maxBytes: bad as never }, search: { maxResults: bad as never } });
      for (const [name, v, lo, hi] of [['timeoutMs', c.exec.timeoutMs, 1, 300000], ['maxBytes', c.output.maxBytes, 32, 1048576], ['maxResults', c.search.maxResults, 1, 1000]] as const) { expect(Number.isFinite(v), `${name} for ${String(bad)}`).toBe(true); expect(v).toBeGreaterThanOrEqual(lo); expect(v).toBeLessThanOrEqual(hi); }
    }
    expect(configure({ exec: { timeoutMs: 10 ** 12 } }).exec.timeoutMs).toBe(300000); expect(configure({ output: { maxBytes: 1 } }).output.maxBytes).toBe(32);
    for (const bad of ['PATH', 5, {}, null]) { const c = configure({ env: { allow: bad as never }, denyPatterns: bad as never }); expect(c.env.allow).toEqual(configure().env.allow); expect(c.denyPatterns).toEqual([]); }
    expect(configure({ env: { allow: ['PATH', 'X'] }, denyPatterns: ['rm'] })).toMatchObject({ env: { allow: ['PATH', 'X'] }, denyPatterns: ['rm'] });
  });
});
