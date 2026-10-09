import { FsFailure } from '../../core/src/tools/fs/failure.ts';
export class HostctlError extends Error {
  readonly code: string;
  constructor(code: string, hint: string) { super(hint); this.code = code; }
}
export function fail(code: string, hint: string): never { throw new HostctlError(code, hint); }
export function failure(e: unknown) {
  const code = e instanceof HostctlError ? e.code : e instanceof FsFailure ? (({ 'binary-content': 'BINARY', 'too-large': 'TOO_LARGE', 'path-refused': e.reason === 'deny-listed' ? 'DENIED' : 'OUTSIDE_ROOT', aborted: 'ABORTED', 'not-found': 'NOT_FOUND' } as Record<string, string>)[e.code] ?? 'IO_ERROR') : (e as { name?: string })?.name === 'AbortError' ? 'ABORTED' : 'IO_ERROR';
  return { ok: false as const, error: { code, hint: e instanceof HostctlError ? e.message : e instanceof FsFailure ? e.hint : 'Check the target and permissions; retry only after reviewing the request.' } };
}
export function string(a: Record<string, unknown>, key: string): string {
  const value = a[key]; if (typeof value !== 'string' || value.includes('\0') || !value.isWellFormed()) fail('INVALID_ARGUMENT', `${key} must be a string without NUL bytes.`); return value;
}
export function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) fail('INVALID_ARGUMENT', `Use an integer between 0 and ${max}.`); return value;
}
