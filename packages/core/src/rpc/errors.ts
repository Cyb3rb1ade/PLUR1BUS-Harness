import { ERROR_CODES, type ErrorCode } from "@plur1bus/rpc-schema";

const DEFAULT_JSONRPC_CODE: Record<ErrorCode, number> = {
  E_UNAUTHORIZED: -32000, E_RPC_VERSION: -32000, E_NOT_AVAILABLE: -32000, E_CORE_UNAVAILABLE: -32000,
  E_INVALID_PARAMS: -32602, E_AGENT_UNKNOWN: -32000, E_CONFIG_INVALID: -32000, E_MODULE_UNKNOWN: -32000, E_INTERNAL: -32000, E_LOCKED: -32000,
};

export class RpcError extends Error {
  error: ErrorCode; reason?: string; detail?: string; jsonrpcCode: number;
  constructor(error: ErrorCode, message: string, opts: { reason?: string; detail?: string; jsonrpcCode?: number } = {}) {
    if (!ERROR_CODES.includes(error)) throw new Error(`unknown error code ${error}`);
    super(message); this.name = "RpcError"; this.error = error; this.jsonrpcCode = opts.jsonrpcCode ?? DEFAULT_JSONRPC_CODE[error] ?? -32000;
    if (opts.reason !== undefined) this.reason = opts.reason;
    if (opts.detail !== undefined) this.detail = opts.detail;
  }
  toJSON() {
    const data: Record<string, string> = { error: this.error };
    if (this.reason) data.reason = this.reason; if (this.detail) data.detail = this.detail;
    return { code: this.jsonrpcCode, message: this.message, data };
  }
}
