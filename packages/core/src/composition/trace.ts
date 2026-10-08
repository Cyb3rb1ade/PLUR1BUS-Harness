import { randomBytes } from 'node:crypto';
import { currentTrace, newTrace, withTrace } from '../logs/trace.ts';
export interface PipelineRecord { stage: string; phase: 'start' | 'end' | 'error'; trace_id: string; span_id: string; parent_span_id: string; durationMs?: number; code?: string }
export type PipelineLog = (record: PipelineRecord) => void;
export function errorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    if ('code' in error && typeof error.code === 'string') return error.code;
    if ('kind' in error && typeof error.kind === 'string') return error.kind;
  }
  return 'turn-failed';
}
/** Stage boundaries keep original exceptions and parentage; AsyncLocalStorage also reaches component writers. */
export async function stage<T>(name: string, signal: AbortSignal, log: PipelineLog, run: () => T | Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const parent = currentTrace() ?? newTrace();
  const span_id = randomBytes(8).toString('hex');
  const context = { trace_id: parent.trace_id, span_id, traceparent: `00-${parent.trace_id}-${span_id}-01` };
  const base = { stage: name, trace_id: context.trace_id, span_id, parent_span_id: parent.span_id };
  const start = performance.now();
  log({ ...base, phase: 'start' });
  return withTrace(context, async () => {
    try { const value = await run(); signal.throwIfAborted(); log({ ...base, phase: 'end', durationMs: performance.now() - start }); return value; }
    catch (e) { log({ ...base, phase: 'error', code: errorCode(e), durationMs: performance.now() - start }); throw e; }
  });
}
