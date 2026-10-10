import { RpcError } from "../rpc/errors.ts";
import type { MediaErrorCode } from "./types.ts";

type ErrorCodeArg = ConstructorParameters<typeof RpcError>[0];

/** RpcError with an E_MEDIA_* code. Falls back to a registered carrier code while the RPC schema does not know the media codes yet. */
export function mediaError(code: MediaErrorCode, message: string, data: { reason?: string; detail?: string; ids?: Record<string, string> } = {}): RpcError {
  try { return new RpcError(code as unknown as ErrorCodeArg, message, data); }
  catch { const e = new RpcError("E_INTERNAL", message, data); e.error = code as unknown as ErrorCodeArg; return e; }
}
