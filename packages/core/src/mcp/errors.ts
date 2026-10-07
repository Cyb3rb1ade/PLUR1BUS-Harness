// ADR-014 §6: one error class with a closed code vocabulary. A tool that ran and reported `isError` is a result,
// not an exception; these are the protocol, transport, policy and deadline failures.
export type McpErrorCode =
  | "invalid-config" | "not-allowed" | "not-registered"
  | "connect-failed" | "connect-timeout" | "call-timeout" | "aborted"
  | "unknown-tool" | "server-error" | "protocol" | "closed";

const RETRYABLE: ReadonlySet<McpErrorCode> = new Set(["connect-failed", "connect-timeout", "call-timeout", "closed"]);

export class McpClientError extends Error {
  readonly code: McpErrorCode;
  readonly server: string | null;
  readonly retryable: boolean;
  constructor(code: McpErrorCode, message: string, opts: { server?: string | null; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "McpClientError";
    this.code = code;
    this.server = opts.server ?? null;
    this.retryable = RETRYABLE.has(code);
  }
}
