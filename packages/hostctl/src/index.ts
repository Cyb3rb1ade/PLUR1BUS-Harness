import { createRedactor } from '../../core/src/logs/redact.ts';
import { cpus, freemem, totalmem, networkInterfaces, platform, release, arch } from 'node:os';
import { statfs } from 'node:fs/promises';
import type { PathRoot, DenyEntry } from '../../core/src/policy/paths-index.ts';
import { CAPABILITIES } from '../../core/src/policy/index.ts';
import type { ToolDef } from '../../core/src/tools/registry.ts';
import { createNodeHostContext, getHostTool, type HostContext } from '../../core/src/host-tools/index.ts';
import { configure, type ConfigInput } from './config.ts';
import { fail, failure, string } from './errors.ts';
import { files } from './files.ts';
import { processes, type ProcessOptions, type RunContext } from './processes.ts';
import * as native from './native.ts';
export type { RunContext } from './processes.ts';
export type { ConfigInput, HostctlConfig } from './config.ts';
export { DEFAULT_CONFIG } from './config.ts';
export interface Audit { operation: string; phase: 'begin' | 'end'; agentId: string; principal: string; sessionId?: string; paths: string[]; code: string; processId?: string; pid?: number }
export interface Options extends ProcessOptions {
  /** Synthetic home seam for offline fixtures; composition uses the OS home. */
  home?: string;
  roots: readonly PathRoot[]; deny?: readonly DenyEntry[]; config?: ConfigInput; audit: (event: Audit) => void;
  trash?: (path: string, signal: AbortSignal) => Promise<void>; host?: HostContext;
  /** Trusted native seam for tests; never exposed as a tool argument. */
  killForeign?: (pid: number) => void;
  /** Trusted staging seam for deterministic cancellation tests; never a tool argument. */
  afterStage?: () => Promise<void>;
}
const text = { type: 'string', maxLength: 65536 };
const pathSchema = { type: 'string', minLength: 1, maxLength: 4096, description: 'Local path inside a configured D109 root; no parent traversal, UNC or credential paths.' };
const number = (maximum: number) => ({ type: 'integer', minimum: 0, maximum });
type Spec = { capability: string; description: string; properties: Record<string, unknown>; required: string[] };
const spec = (capability: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): Spec => ({ capability, description, properties, required });
export const SPECS: Readonly<Record<string, Spec>> = {
  'fs.read': spec('fs.read', 'Read bounded UTF-8 text. Byte offset/length support ranges; binary files are refused.', { path: pathSchema, offset: number(Number.MAX_SAFE_INTEGER), length: number(1048576) }, ['path']),
  'fs.write': spec('fs.write', 'Atomically replace or create a UTF-8 file via a temporary file and rename.', { path: pathSchema, content: text }, ['path', 'content']),
  'fs.append': spec('fs.write', 'Atomically append UTF-8 text to an existing bounded file.', { path: pathSchema, content: text }, ['path', 'content']),
  'fs.edit': spec('fs.write', 'Replace exactly one literal occurrence; zero or multiple matches yield NOT_UNIQUE.', { path: pathSchema, oldText: { ...text, minLength: 1 }, newText: text }, ['path', 'oldText', 'newText']),
  'fs.list': spec('fs.read', 'List root-contained entries recursively to depth, sorted per directory; never follow links.', { path: pathSchema, depth: number(16), limit: number(1000) }, ['path']),
  'fs.search': spec('fs.read', 'Bounded literal name/content search, UTF-8 files only; respects roots and deny-list.', { path: pathSchema, query: { ...text, minLength: 1 }, mode: { enum: ['name', 'content'] }, depth: number(16), limit: number(1000) }, ['path', 'query']),
  'fs.stat': spec('fs.read', 'Return type, size and modification time for an entry inside roots.', { path: pathSchema }, ['path']),
  'fs.mkdir': spec('fs.write', 'Create one directory; parent must already exist inside roots.', { path: pathSchema }, ['path']),
  'fs.copy': spec('fs.write', 'Copy one bounded regular file exclusively; destination must not exist.', { path: pathSchema, destination: pathSchema }, ['path', 'destination']),
  'fs.move': spec('fs.write', 'Move a regular file inside roots; destination must not exist. Cross-filesystem moves are refused.', { path: pathSchema, destination: pathSchema }, ['path', 'destination']),
  'fs.trash': spec('hostctl.fs.trash', 'Send an entry to native Trash/Recycle Bin. Never permanently deletes; refuses root itself.', { path: pathSchema }, ['path']),
  'proc.exec': spec('shell.exec', 'Run argv without a shell, bounded by timeout/output/env; wait for completion.', { program: pathSchema, args: { type: 'array', items: text, maxItems: 256 }, cwd: pathSchema, timeoutMs: number(300000), env: { type: 'object', additionalProperties: text } }, ['program', 'cwd']),
  'proc.start': spec('shell.exec', 'Start a bounded argv process and return an opaque ID owned by this agent session.', { program: pathSchema, args: { type: 'array', items: text, maxItems: 256 }, cwd: pathSchema, timeoutMs: number(300000), env: { type: 'object', additionalProperties: text } }, ['program', 'cwd']),
  'proc.shell': spec('shell.exec', 'Run a command in the configured bash/zsh/pwsh only if shell.allowed is true.', { command: text, cwd: pathSchema, timeoutMs: number(300000), env: { type: 'object', additionalProperties: text } }, ['command', 'cwd']),
  'proc.list': spec('hostctl.proc.session.read', 'List only process sessions owned by this agent, person and harness session.'),
  'proc.read_output': spec('hostctl.proc.session.read', 'Read bounded retained stdout/stderr and exit/timeout state of an owned process session.', { id: text }, ['id']),
  'proc.write_stdin': spec('hostctl.proc.session.write', 'Write bounded text to an owned running process session; eof closes stdin.', { id: text, text, eof: { type: 'boolean' } }, ['id', 'text']),
  'proc.kill': spec('proc.signal', 'Terminate an owned process session including descendants.', { id: text }, ['id']),
  'proc.kill_foreign': spec('hostctl.proc.kill_foreign', 'Signal a foreign PID only after a separate D109 approval; cannot target self or PID 0/1.', { pid: { type: 'integer', minimum: 2 }, signal: { enum: ['SIGTERM'] } }, ['pid']),
  'sys.info': spec('sys.read', 'Return OS/CPU/RAM, root disk capacity and network addresses; no environment, user, hostname or MAC.'),
  'app.open': spec('os.script', 'Open a root-contained local file or credential-free HTTP(S) URL with the OS default app.', { target: pathSchema }, ['target']),
  'clipboard.read': spec('clipboard.read', 'Read the local clipboard after D109 approval; contents never enter audit logs.'),
  'clipboard.write': spec('clipboard.read', 'Write the local clipboard after D109 approval, using stdin; contents never enter audit logs.', { text }, ['text']),
  'notify': spec('os.script', 'Display a local desktop notification; no text in audit logs.', { title: { type: 'string', minLength: 1, maxLength: 200 }, body: { type: 'string', maxLength: 2000 } }, ['title']),
};
/** Internal executor. Production callers use definitions() behind ToolDispatcher; it never makes approval decisions. */
export function createHostctl(o: Options) {
  const config = configure(o.config), fs = files(o.roots, o.deny ?? [], config, o.trash ?? native.trash, o.home, o.baseEnv, o.afterStage), proc = processes(config, fs.canon, o);
  const redactor = createRedactor();
  let closed = false;
  async function invoke(name: string, raw: unknown, ctx: RunContext) {
    const op = name.replace(/^hostctl\./, ''); const description = SPECS[op];
    const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const paths = ['path', 'destination', 'cwd'].flatMap(key => typeof a[key] === 'string' ? [a[key] as string] : []);
    let processId = typeof a.id === 'string' && /^[a-f0-9-]{36}$/.test(a.id) ? a.id : undefined;
    let pid = typeof a.pid === 'number' && Number.isSafeInteger(a.pid) && a.pid > 1 ? a.pid : undefined;
    const event = (phase: Audit['phase'], code: string) => o.audit(redactor.value({ operation: name, phase, agentId: ctx.agentId, principal: ctx.principal, ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}), paths, code, ...(processId ? { processId } : {}), ...(pid ? { pid } : {}) }));
    try {
      try { event('begin', 'START'); } catch { fail('DENIED', 'Audit is unavailable; no operation was performed.'); }
      if (!config.enabled || closed) fail('DENIED', 'Hostctl is disabled or closed.');
      if (!description) fail('INVALID_ARGUMENT', 'Choose a registered hostctl tool.');
      for (const key of description.required) if (a[key] === undefined) fail('INVALID_ARGUMENT', `${key} is required.`);
      for (const key of Object.keys(a)) if (!(key in description.properties)) fail('INVALID_ARGUMENT', `Unknown argument: ${key}.`);
      ctx.signal.throwIfAborted(); let value: unknown;
      if (op.startsWith('fs.')) value = await fs.run(op.slice(3), a, ctx.signal);
      else if (op === 'proc.kill_foreign') { const pid = a.pid; if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 2 || pid === process.pid) fail('DENIED', 'Use a foreign PID greater than 1.'); (o.killForeign ?? (pid => process.kill(pid, 'SIGTERM')))(pid); value = { signalled: true }; }
      else if (op.startsWith('proc.')) value = await proc.run(op.slice(5), a, ctx);
      else if (op === 'sys.info') {
        value = { os: platform(), release: release(), arch: arch(), cpu: { model: cpus()[0]?.model, count: cpus().length }, memory: { total: totalmem(), free: freemem() }, disks: await Promise.all(o.roots.map(async root => { try { const s = await statfs(root.path); return { rootId: root.id, total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } catch { return { rootId: root.id, unavailable: true }; } })), network: Object.entries(networkInterfaces()).map(([name, addresses]) => ({ name, addresses: addresses?.map(({ address, family, internal }) => ({ address, family, internal })) })) };
      } else if (op === 'app.open') {
        let target = string(a, 'target');
        if (/^https?:\/\//i.test(target)) { const u = new URL(target); if (u.username || u.password) fail('DENIED', 'Use a URL without credentials.'); target = u.href; }
        else target = (await fs.canon(target, 'read')).canonical;
        await native.open(target, ctx.signal); value = { opened: true };
      } else {
        const tool = getHostTool(op); if (!tool) fail('UNAVAILABLE', 'Native operation unavailable.');
        value = await tool.run(a, { ...(o.host ?? createNodeHostContext()), signal: ctx.signal, timeoutMs: config.exec.timeoutMs, maxOutputBytes: config.output.maxBytes });
      }
      if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' && /^[a-f0-9-]{36}$/.test(value.id)) processId = value.id;
      if (value && typeof value === 'object' && 'pid' in value && typeof value.pid === 'number') pid = value.pid;
      event('end', 'OK'); return { ok: true as const, value };
    } catch (e) { const result = failure(e); try { event('end', result.error.code); } catch { /* The begin event is the fail-closed boundary. */ } return result; }
  }
  return {
    invoke,
    definitions(): ToolDef[] { return config.enabled ? Object.entries(SPECS).map(([op, s]) => {
      const cap = CAPABILITIES.get(s.capability)!;
      return { name: `hostctl.${op}`, description: s.description, inputSchema: { type: 'object', additionalProperties: false, properties: s.properties, required: s.required }, capability: s.capability, effect: op === 'clipboard.write' ? 'local-write' : cap.intrinsicEffect, risk: cap.baseRisk, trust: 'first-party', limits: { timeoutMs: Math.min(300000, config.exec.timeoutMs + 1000), maxResultBytes: Math.min(1048576, config.output.maxBytes * 2 + 4096) }, classify: async (raw: unknown) => {
        const a = raw as Record<string, unknown>; const targets: string[] = []; const access = /^(fs\.(read|list|search|stat)|proc\.(exec|start|shell))$/.test(op) ? 'read' : 'write';
        for (const key of ['path', 'destination', 'cwd']) if (typeof a[key] === 'string') { try { targets.push((await fs.canon(a[key], access)).canonical); } catch { return { flags: { outsideRoots: true, denyListHit: true }, targets: [] }; } }
        if (op === 'app.open' && typeof a.target === 'string' && !/^https?:\/\//i.test(a.target)) { try { targets.push((await fs.canon(a.target, 'read')).canonical); } catch { return { flags: { outsideRoots: true, denyListHit: true } }; } }
        return { flags: { outsideRoots: false }, targets, access };
      }, execute: (args, ctx) => invoke(`hostctl.${op}`, args, ctx) };
    }) : []; },
    endSession: proc.endSession,
    async close() { closed = true; await proc.close(); },
  };
}
export type Hostctl = ReturnType<typeof createHostctl>;
