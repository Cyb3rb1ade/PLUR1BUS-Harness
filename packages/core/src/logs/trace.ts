import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
export interface TraceContext { trace_id: string; span_id: string; traceparent: string; link_trace_id?: string }
const storage = new AsyncLocalStorage<TraceContext>();
export function parseTraceparent(value: unknown): TraceContext | null {
  if (typeof value !== "string") return null;
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
  if (!m || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return null;
  return { trace_id: m[1]!, span_id: m[2]!, traceparent: value };
}
export function newTrace(): TraceContext {
  const trace_id = randomBytes(16).toString("hex"); const span_id = randomBytes(8).toString("hex");
  return { trace_id, span_id, traceparent: `00-${trace_id}-${span_id}-01` };
}
export const currentTrace = (): TraceContext | undefined => storage.getStore();
export const withTrace = <T>(context: TraceContext, fn: () => T): T => storage.run(context, fn);
/** Only an authenticated, trusted caller can adopt a carrier. No outbound vendor carrier is provided. */
export function fromRpcMeta(meta: unknown, trusted: boolean): TraceContext {
  const parsed = parseTraceparent((meta as { traceparent?: unknown } | null)?.traceparent);
  if (trusted && parsed) return parsed;
  return { ...newTrace(), ...(parsed ? { link_trace_id: parsed.trace_id } : {}) };
}
