import type { ToolResult, ToolErrorCode } from './dispatcher.ts';

export interface ArgumentShape { objects: number; arrays: number; strings: number; numbers: number; booleans: number; nulls: number; fields: number; depth: number; truncated: boolean }
export interface LearningToolMetadata { version: 1; tool: string; errorClass: ToolErrorCode; shape: ArgumentShape }
const codes = new Set<ToolErrorCode>(['tool-unknown', 'tool-call-invalid', 'tool-denied', 'tool-not-approved', 'tool-timeout', 'tool-failed', 'tool-result-too-large', 'tool-result-invalid', 'aborted']);
const branded = new WeakMap<object, LearningToolMetadata>();
/** No argument names, values, diagnostic prose or arbitrary provider error codes. */
export function learningToolMetadata(result: ToolResult, args: unknown, registered: boolean): LearningToolMetadata | null {
  if (!result.isError || !codes.has(result.error.code)) return null;
  const shape: ArgumentShape = { objects: 0, arrays: 0, strings: 0, numbers: 0, booleans: 0, nulls: 0, fields: 0, depth: 0, truncated: false };
  let visited = 0;
  const walk = (value: unknown, depth: number): void => {
    if (++visited > 256 || depth > 8) { shape.truncated = true; return; }
    shape.depth = Math.max(shape.depth, depth);
    if (value === null || value === undefined) shape.nulls++;
    else if (typeof value === 'string') shape.strings++;
    else if (typeof value === 'number') shape.numbers++;
    else if (typeof value === 'boolean') shape.booleans++;
    else if (typeof value === 'object') {
      if (Array.isArray(value)) shape.arrays++; else shape.objects++;
      const values = Object.values(value); shape.fields += Math.min(values.length, 256);
      for (const child of values.slice(0, 256)) { walk(child, depth + 1); if (visited > 256) break; }
      if (values.length > 256) shape.truncated = true;
    }
  };
  walk(args, 0);
  return { version: 1, tool: registered ? result.tool : 'unknown', errorClass: result.error.code, shape };
}
/** Identity branding prevents serialized provider/model fields from claiming host provenance. */
export function brandLearningTool<T extends object>(chunk: T, result: ToolResult, args: unknown, registered: boolean): T {
  const metadata = learningToolMetadata(result, args, registered); if (metadata) branded.set(chunk, metadata); return chunk;
}
export function takeLearningTool(chunk: object): LearningToolMetadata | null { const value = branded.get(chunk) ?? null; branded.delete(chunk); return value; }
