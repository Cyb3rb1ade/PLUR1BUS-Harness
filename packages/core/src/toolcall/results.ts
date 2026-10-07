import { createHash } from 'node:crypto';
import type { ToolErrorCode } from '../tools/dispatcher.ts';
export interface FullResultPort { put(value: unknown): Promise<string> }
export interface CappedResult { isError: boolean; value?: unknown; error?: { code: ToolErrorCode; hint: string }; truncated: boolean; reference?: string }
/** Default 8k tokens conservatively budgeted as 32 KiB; applications may supply a real token counter upstream. */
export async function capResult(value: unknown, store: FullResultPort, maxBytes = 32 * 1024): Promise<CappedResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128) throw Error('result budget must be at least 128 bytes');
  if (value instanceof Error) return { isError: true, error: { code: 'tool-failed', hint: 'Tool failed; inspect its trace or try a different approach.' }, truncated: false };
  if (value && typeof value === 'object' && 'isError' in value && value.isError === true) {
    const error = 'error' in value && value.error && typeof value.error === 'object' ? value.error : {};
    const codes: readonly ToolErrorCode[] = ['tool-unknown', 'tool-call-invalid', 'tool-denied', 'tool-not-approved', 'tool-timeout', 'tool-failed', 'tool-result-too-large', 'tool-result-invalid', 'aborted'];
    const code = 'code' in error && codes.includes(error.code as ToolErrorCode) ? error.code as ToolErrorCode : 'tool-failed';
    const hint = 'hint' in error && typeof error.hint === 'string' ? error.hint.replace(/[\r\n]+/g, ' ').slice(0, 80) : 'Tool reported an error.';
    const result: CappedResult = { isError: true, error: { code, hint }, truncated: false };
    if (Buffer.byteLength(JSON.stringify(result)) <= maxBytes) return result;
    const reference = await store.put(value);
    const compact: CappedResult = { isError: true, truncated: true, reference };
    if (Buffer.byteLength(JSON.stringify(compact)) > maxBytes) throw Error('full-result reference exceeds result budget');
    return compact;
  }
  const binary = value instanceof Uint8Array || value instanceof ArrayBuffer;
  const envelope: CappedResult = { isError: false, value, truncated: false };
  let text: string | undefined;
  if (!binary) try { text = JSON.stringify(envelope); } catch { /* reference non-JSON data */ }
  if (text !== undefined && Buffer.byteLength(text) <= maxBytes) return JSON.parse(text) as CappedResult;
  const reference = await store.put(value);
  const result: CappedResult = { isError: false, truncated: true, reference };
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw Error('full-result reference exceeds result budget');
  return result;
}
function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (typeof value !== 'object' || seen.has(value)) throw Error('idempotency arguments must be finite acyclic JSON');
  seen.add(value);
  const text = Array.isArray(value) ? `[${value.map(v => canonical(v, seen)).join(',')}]` : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k], seen)}`).join(',')}}`;
  seen.delete(value); return text;
}
/** Scope should include agent, session and logical task; never reuse it across unrelated user actions. */
export function idempotencyKey(scope: string, name: string, args: unknown): string {
  return createHash('sha256').update(canonical([scope, name, args])).digest('hex');
}
export interface BatchCall { name: string; arguments: unknown; parallelSafe: boolean; operationId?: string }
export interface IdempotencyPort { run(key: string, execute: () => Promise<unknown>): Promise<unknown> }
/** In-memory port coalesces concurrent/repeated calls; a durable port is required across process restarts. */
export class MemoryIdempotency implements IdempotencyPort {
  readonly #calls = new Map<string, Promise<unknown>>();
  run(key: string, execute: () => Promise<unknown>): Promise<unknown> {
    let p = this.#calls.get(key); if (!p) { p = Promise.resolve().then(execute); this.#calls.set(key, p); } return p;
  }
  clear(): void { this.#calls.clear(); }
}
/** Unsafe calls form barriers; parallel groups return results in request order. Policy remains the executor's responsibility. */
export async function executeBatch(scope: string, calls: readonly BatchCall[], execute: (call: BatchCall, key: string) => Promise<unknown>, idempotency: IdempotencyPort = new MemoryIdempotency()): Promise<unknown[]> {
  const out: unknown[] = []; let group: Promise<unknown>[] = [];
  const flush = async () => { out.push(...await Promise.all(group)); group = []; };
  const run = (call: BatchCall) => {
    const key = idempotencyKey(`${scope}:${call.operationId ?? ''}`, call.name, call.arguments);
    return idempotency.run(key, async () => { try { return await execute(call, key); } catch { return { isError: true, error: { code: 'tool-failed', hint: 'Tool execution failed.' } }; } });
  };
  for (const call of calls) { if (call.parallelSafe) group.push(run(call)); else { await flush(); out.push(await run(call)); } }
  await flush(); return out;
}
