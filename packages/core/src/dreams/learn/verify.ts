import { isAbsolute, posix, win32 } from 'node:path';
import type { Finding } from './types.ts';

/** Host binds this port to the ordinary D109 dispatcher in the trusted project root. No other tool is exposed. */
export interface LearnReadPort { call(name: 'file.read' | 'file.list', args: { path: string; maxBytes?: number; maxEntries?: number }, signal: AbortSignal): Promise<{ ok: boolean; text?: string; truncated?: boolean }> }
export function safeVerifyPath(path: string): boolean {
  return path.length > 0 && path.length <= 256 && !isAbsolute(path) && !win32.isAbsolute(path) && !path.includes('\\') &&
    !/[\x00-\x1f]/.test(path) && !path.split('/').some(p => p === '..' || p.startsWith('.')) && posix.normalize(path) === path &&
    !/(?:secret|credential|password|private[-_.]?key)/i.test(path);
}
export async function verifyFinding(finding: Finding, port: LearnReadPort | null, signal: AbortSignal): Promise<Finding['verify']> {
  if (finding.target.scope !== 'project') return 'not-applicable';
  if (!port || !finding.checks?.length || finding.checks.length > 8) return 'unknown';
  let supported = true;
  for (const check of finding.checks) {
    signal.throwIfAborted();
    if (!safeVerifyPath(check.path)) return 'unknown';
    // Deliberately no generalized tool name from a model, no shell and no configuration-file fallback.
    const result = await port.call('file.read', { path: check.path, maxBytes: 32_768 }, signal);
    if (!result.ok || result.truncated || typeof result.text !== 'string' || Buffer.byteLength(result.text) > 32_768) return 'unknown';
    if (!result.text.includes(check.contains)) supported = false;
  }
  return supported ? 'supported' : 'contradicted';
}
