// Shared ACP schema v1 types for the agent side and the external-agent client. No SDK.

export const ACP_PROTOCOL_VERSION = 1;

export const ACP_MAX_OPEN_REQUESTS = 8;
export const ACP_MAX_UPDATES = 200;
export const ACP_REQUEST_TIMEOUT_MS = 15_000;

export type JsonRpcId = string | number;

export interface JsonRpcError { code: number; message: string; data?: Record<string, string | number> }

export const ACP_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;
