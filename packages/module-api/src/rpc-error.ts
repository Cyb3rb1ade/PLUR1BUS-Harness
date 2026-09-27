import { ERROR_CODES, type ErrorCode } from "@plur1bus/rpc-schema";

const DEFAULT_JSONRPC_CODE: Record<ErrorCode, number> = {
  E_UNAUTHORIZED: -32000, E_RPC_VERSION: -32000, E_NOT_AVAILABLE: -32000, E_CORE_UNAVAILABLE: -32000,
  E_INVALID_PARAMS: -32602, E_AGENT_UNKNOWN: -32000, E_CONFIG_INVALID: -32000, E_MODULE_UNKNOWN: -32000, E_INTERNAL: -32000, E_LOCKED: -32000,
  E_NOT_FOUND: -32000, E_DENIED: -32000, E_APPROVAL_REQUIRED: -32000, E_CONFLICT: -32000, E_STORAGE: -32000,
};

export interface RpcErrorData { error: ErrorCode; reason?: string; detail?: string; ids?: Record<string, string> }

export class RpcError extends Error {
  error: ErrorCode; reason?: string; detail?: string; ids?: Record<string, string>; jsonrpcCode: number;
  constructor(error: ErrorCode, message: string, opts: { reason?: string; detail?: string; ids?: Record<string, string>; jsonrpcCode?: number } = {}) {
    if (!ERROR_CODES.includes(error)) throw new Error(`unknown error code ${error}`);
    super(message); this.name = "RpcError"; this.error = error; this.jsonrpcCode = opts.jsonrpcCode ?? DEFAULT_JSONRPC_CODE[error] ?? -32000;
    if (opts.reason !== undefined) this.reason = opts.reason;
    if (opts.detail !== undefined) this.detail = opts.detail;
    if (opts.ids !== undefined) this.ids = { ...opts.ids };
  }
  toJSON(): { code: number; message: string; data: RpcErrorData } {
    const data: RpcErrorData = { error: this.error };
    if (this.reason) data.reason = this.reason; if (this.detail) data.detail = this.detail;
    if (this.ids && Object.keys(this.ids).length > 0) data.ids = { ...this.ids };
    return { code: this.jsonrpcCode, message: this.message, data };
  }
}
