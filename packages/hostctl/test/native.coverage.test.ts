import { afterEach, describe, expect, it, vi } from 'vitest';
import { native, trash } from '../src/native.ts';
import { HostctlError } from '../src/errors.ts';

// Only local Node children run here: no OS opener, no Trash helper, no network.
const nodeProgram = process.execPath;
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const sleepingScript = 'setInterval(() => {}, 1000)';
const codeOf = async (p: Promise<unknown>) => { try { await p; return undefined; } catch (e) { return e instanceof HostctlError ? e.code : (e as Error).name; } };

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.useRealTimers();
});

describe('native() argv runner', () => {
  it('resolves when the helper exits with code 0', async () => {
    await expect(native(nodeProgram, ['-e', 'process.exit(0)'], new AbortController().signal)).resolves.toBeUndefined();
  });

  it('reports IO_ERROR with a permission hint when the helper exits non-zero', async () => {
    const outcome = native(nodeProgram, ['-e', 'process.exit(3)'], new AbortController().signal);
    await expect(outcome).rejects.toMatchObject({ code: 'IO_ERROR', message: 'Native helper failed; check desktop permissions and target support.' });
  });

  it('reports UNAVAILABLE when the program does not exist', async () => {
    expect(await codeOf(native('/nonexistent/hostctl-fixture-helper', [], new AbortController().signal))).toBe('UNAVAILABLE');
  });

  it('delivers stdin input byte-exact, including Unicode', async () => {
    const script = "let d=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => d += c); process.stdin.on('end', () => process.exit(d === 'héllo 🙂' ? 0 : 5));";
    await expect(native(nodeProgram, ['-e', script], new AbortController().signal, 'héllo 🙂')).resolves.toBeUndefined();
    expect(await codeOf(native(nodeProgram, ['-e', script], new AbortController().signal, 'hello'))).toBe('IO_ERROR');
  });

  it('delivers a one-megabyte stdin payload completely', async () => {
    const script = "let n = 0; process.stdin.on('data', c => n += c.length); process.stdin.on('end', () => process.exit(n === 1048576 ? 0 : 5));";
    await expect(native(nodeProgram, ['-e', script], new AbortController().signal, 'x'.repeat(1048576))).resolves.toBeUndefined();
  });

  it('passes argv without a shell, so shell metacharacters stay literal', async () => {
    const script = "process.exit(process.argv[1] === '$(touch hostctl-never);`x`' ? 0 : 9)";
    await expect(native(nodeProgram, ['-e', script, '$(touch hostctl-never);`x`'], new AbortController().signal)).resolves.toBeUndefined();
  });

  it('throws the signal reason synchronously when the signal is already aborted', () => {
    const ac = new AbortController(); ac.abort();
    let thrown: unknown;
    try { native(nodeProgram, ['-e', 'process.exit(0)'], ac.signal); } catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    expect(thrown).not.toBeInstanceOf(HostctlError);
    expect((thrown as Error).name).toBe('AbortError');
  });

  it.skipIf(process.platform === 'win32')('aborting a running helper kills it and reports ABORTED', async () => {
    const ac = new AbortController();
    const outcome = native(nodeProgram, ['-e', sleepingScript], ac.signal);
    ac.abort();
    expect(await codeOf(outcome)).toBe('ABORTED');
  });

  it.skipIf(process.platform === 'win32')('a helper that outlives the 30 second budget is killed and reports TIMEOUT', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const outcome = native(nodeProgram, ['-e', sleepingScript], new AbortController().signal);
    const code = codeOf(outcome);
    await vi.advanceTimersByTimeAsync(30000);
    expect(await code).toBe('TIMEOUT');
  });
});

describe('native Trash on an unsupported platform', () => {
  it('refuses with UNAVAILABLE and never falls back to permanent deletion', async () => {
    Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true });
    const outcome = trash('/nonexistent/hostctl-fixture-target', new AbortController().signal);
    Object.defineProperty(process, 'platform', originalPlatform);
    await expect(outcome).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'Native Trash is not available; no permanent-delete fallback exists.' });
  });
});
