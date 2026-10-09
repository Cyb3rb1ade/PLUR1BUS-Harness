import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
import { trash, open } from '../src/native.ts';
const actualProcess = process;
afterEach(() => { vi.unstubAllGlobals(); spawn.mockReset(); });
for (const platform of ['darwin', 'linux', 'win32']) {
  describe(`native ${platform} argv contract`, () => {
    it('Trash uses fixed helper code/argv, never permanent delete', async () => {
      vi.stubGlobal('process', { ...actualProcess, platform }); let stdin = '';
      spawn.mockImplementation(() => {
        const c = new EventEmitter() as any; c.pid = 999; c.stdin = new PassThrough(); c.stdin.on('data', (b: Buffer) => { stdin += b.toString(); });
        queueMicrotask(() => c.emit('close', 0)); return c;
      });
      const target = platform === 'win32' ? 'C:\\fixture\\";evil.txt' : '/fixture/";evil.txt';
      await trash(target, new AbortController().signal);
      const [program, args, options] = spawn.mock.calls[0]!; expect(options.shell).toBe(false);
      if (platform === 'darwin') { expect(program).toBe('/usr/bin/osascript'); expect(args.at(-1)).toBe(target); expect(args[1]).not.toContain(target); }
      if (platform === 'linux') expect(args).toEqual(['trash', '--', target]);
      if (platform === 'win32') { expect(stdin).toBe(target); expect(args.at(-1)).toContain('SendToRecycleBin'); expect(args.at(-1)).not.toContain(target); }
    });
    it('app opener passes targets as argv/stdin without shell interpolation', async () => {
      vi.stubGlobal('process', { ...actualProcess, platform });
      spawn.mockImplementation(() => { const c = new EventEmitter() as any; c.stdin = new PassThrough(); queueMicrotask(() => c.emit('close', 0)); return c; });
      await open('https://example.invalid/?q=%22', new AbortController().signal);
      expect(spawn).toHaveBeenCalledOnce(); expect(spawn.mock.calls[0]![2].shell).toBe(false);
    });
  });
}
it('Windows tree cleanup uses taskkill argv without a shell', async () => {
  vi.stubGlobal('process', { ...actualProcess, platform: 'win32' });
  spawn.mockImplementation(() => { const c = new EventEmitter() as any; queueMicrotask(() => c.emit('close', 0)); return c; });
  const { killTree } = await import('../src/processes.ts');
  await killTree({ pid: 12345 } as any);
  expect(spawn.mock.calls[0]).toEqual(['taskkill.exe', ['/PID', '12345', '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }]);
});
