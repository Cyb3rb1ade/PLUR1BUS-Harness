import { MediaError } from '../../types.ts';
import type { ErrorCode } from '../../types.ts';
/** Stable sub-keys for failures that share one `ErrorCode`. `ErrorCode` itself is a closed union in types.ts and is not extended. */
export type ErrorReason = 'auth_invalid' | 'auth_forbidden' | 'drawthings_not_installed' | 'drawthings_api_off' | 'coreml_unavailable_platform';
/** A MediaError with a machine-readable `reason` and a fixed, secret-free hint. Remote text never enters the message. */
export class DetailedMediaError extends MediaError {
  readonly reason: ErrorReason; readonly hint: string;
  constructor(code: ErrorCode, reason: ErrorReason, hint: string) {
    super(code); this.reason = reason; this.hint = hint; this.message = `Media operation failed: ${code} (${reason}). ${hint}`;
  }
}
export function authError(reason: 'auth_invalid' | 'auth_forbidden', adapter: string): DetailedMediaError {
  return new DetailedMediaError('backend_unavailable', reason, `Check the API key or secret reference for ${adapter}.`);
}
export function reasonOf(error: unknown): ErrorReason | undefined { return error instanceof DetailedMediaError ? error.reason : undefined; }
