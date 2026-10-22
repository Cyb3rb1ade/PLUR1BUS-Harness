import { canonicalisePath, type DenyEntry, type PathRoot } from '../policy/paths.ts';
import type { ToolClassification } from '../tools/registry.ts';
import { isSecretishName } from '../tools/exec/env.ts';
import type { HostTool } from './types.ts';
/** Classifies host arguments without treating labels or URLs as filesystem roots. Missing hooks stay outside. */
export async function classifyHostTool(tool: HostTool, args: unknown, o: { roots: readonly PathRoot[]; deny: readonly DenyEntry[] }): Promise<ToolClassification> {
  const a = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  if (a.env && typeof a.env === 'object' && Object.keys(a.env).some(n => isSecretishName(n) || /^(?:SUDO_|LD_|DYLD_|NODE_)/i.test(n))) return { flags: { outsideRoots: true, denyListHit: true } };
  const access = tool.capability === 'sys.read' ? 'read' : 'write';
  const raw = typeof a.cwd === 'string' ? a.cwd : tool.name === 'apps.open' && a.kind !== 'app' && a.kind !== 'url' && typeof a.target === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(a.target) ? a.target : undefined;
  if (raw === undefined) return { flags: { outsideRoots: true, denyListHit: false }, access };
  const c = await canonicalisePath(raw, { roots: o.roots, deny: o.deny, access, requireRoot: false, ...(o.roots[0] ? { cwd: o.roots[0].path } : {}) });
  return c.ok ? { flags: { outsideRoots: c.rootId === null, denyListHit: false, ...(c.systemTree ? { systemTree: true } : {}) }, targets: [c.canonical], access } : { flags: { outsideRoots: true, denyListHit: true }, access };
}
