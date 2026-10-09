import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ErrorReason } from './_shared/errors.ts';
export type ProbeResult = { state: 'running' } | { state: 'api_off' | 'not_installed'; reason: ErrorReason };
export interface ProbeDeps { fetch?: typeof fetch; appInstalled?: () => boolean; platform?: string; timeoutMs?: number }
const defaultInstalled = () => ['/Applications/Draw Things.app', join(homedir(), 'Applications', 'Draw Things.app')].some(p => existsSync(p));
/**
 * Draw Things serves its API only while the app runs and "API Server" is switched on (Settings > Advanced).
 * Any HTTP answer means the server is up. A refused connection on this Mac with no app installed is "not installed".
 */
export async function probeDrawThings(baseUrl: string, deps: ProbeDeps = {}): Promise<ProbeResult> {
  try { await (deps.fetch ?? fetch)(new URL('/', baseUrl), { signal: AbortSignal.timeout(deps.timeoutMs ?? 1500), redirect: 'error' }); return { state: 'running' }; }
  catch { /* connection level failure: classify below */ }
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, ''); const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (local && (deps.platform ?? process.platform) === 'darwin' && !(deps.appInstalled ?? defaultInstalled)()) return { state: 'not_installed', reason: 'drawthings_not_installed' };
  return { state: 'api_off', reason: 'drawthings_api_off' };
}
