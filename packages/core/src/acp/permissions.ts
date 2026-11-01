/** ACP v1 client permission requests are scoped, bounded and fail closed on cancellation or malformed replies. */
import { randomUUID } from "node:crypto";
import { MAX_LINE_BYTES } from "./framing.ts";

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}
export interface AcpPermissionAsk {
  toolCall: Record<string, unknown>;
  options: readonly AcpPermissionOption[];
}
export type AcpPermissionOutcome = { outcome: "cancelled" } | { outcome: "selected"; optionId: string };
export type AcpPermissionHandler = (ask: AcpPermissionAsk, signal?: AbortSignal) => Promise<AcpPermissionOutcome>;
export const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;
export const MAX_PENDING_PERMISSIONS = 64;
const MAX_PERMISSION_OPTIONS = 8;
const CANCELLED: AcpPermissionOutcome = { outcome: "cancelled" };
const KINDS = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
interface Pending {
  sessionId: string;
  options: ReadonlySet<string>;
  finish: (outcome: AcpPermissionOutcome) => void;
}

/** Agent-to-client requests have their own ids; only the matching client's structured result can resolve them. */
export class AcpPermissions {
  readonly #send: (message: unknown) => void;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, Pending>();
  #closed = false;
  constructor(send: (message: unknown) => void, timeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS) {
    this.#send = send;
    this.#timeoutMs = timeoutMs;
  }

  /** Ask only with issued ids and offered options; unavailable capacity, malformed input and abort all cancel. */
  request(sessionId: string, ask: AcpPermissionAsk, signal?: AbortSignal): Promise<AcpPermissionOutcome> {
    if (this.#closed || signal?.aborted || this.#pending.size >= MAX_PENDING_PERMISSIONS) {
      return Promise.resolve(CANCELLED);
    }
    const options = new Set(ask.options.map(option => option.optionId));
    if (!ask.options.length || ask.options.length > MAX_PERMISSION_OPTIONS || options.size !== ask.options.length ||
      ask.options.some(option => !option.optionId || !KINDS.has(option.kind))) return Promise.resolve(CANCELLED);
    const id = `acp-permission-${randomUUID()}`;
    const message = { jsonrpc: "2.0", id, method: "session/request_permission",
      params: { sessionId, toolCall: ask.toolCall, options: ask.options } };
    // A permission is one ACP line too. Do not retain an oversized tool payload while waiting for a human.
    try {
      if (Buffer.byteLength(JSON.stringify(message)) > MAX_LINE_BYTES) return Promise.resolve(CANCELLED);
    } catch {
      return Promise.resolve(CANCELLED);
    }
    return new Promise(resolve => {
      const abort = () => finish(CANCELLED);
      const timer = setTimeout(abort, this.#timeoutMs);
      const finish = (outcome: AcpPermissionOutcome) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(outcome);
      };
      this.#pending.set(id, { sessionId, options, finish });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.#send(message);
      } catch {
        finish(CANCELLED);
      }
    });
  }

  /** Consume one matching reply; unknown ids confer no authority and malformed matching replies cancel. */
  answer(message: unknown): boolean {
    if (!object(message) || message.jsonrpc !== "2.0" || typeof message.id !== "string" || "method" in message) {
      return false;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return false;
    const result = !("error" in message) && object(message.result) ? message.result : undefined;
    const outcome = result && object(result.outcome) ? result.outcome : undefined;
    pending.finish(outcome?.outcome === "selected" && typeof outcome.optionId === "string" &&
      pending.options.has(outcome.optionId)
      ? { outcome: "selected", optionId: outcome.optionId } : CANCELLED);
    return true;
  }

  /** Withdraw this session only; other editor tabs keep their pending choices. */
  cancelSession(sessionId: string): void {
    for (const pending of this.#pending.values()) if (pending.sessionId === sessionId) pending.finish(CANCELLED);
  }
  /** Settle all outstanding choices before the protocol transport closes. */
  close(): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.finish(CANCELLED);
  }
  /** Number of retained choices, bounded by MAX_PENDING_PERMISSIONS. */
  get pending(): number {
    return this.#pending.size;
  }
}
