/** Port implementation owns access control, persistence and retrieval of complete peer output. */
export interface SubagentResultPort { store(value: unknown): string }
export interface SubagentCapOptions { limit?: number; port: SubagentResultPort; countTokens?: (text: string) => number }
/** Conservative UTF-8 byte upper bound for byte-level tokenizers; inject the target model tokenizer for exact counts. */
export const estimateResultTokens = (text: string): number => Buffer.byteLength(text, 'utf8');
export type CappedSubagentResult = { kind: 'complete'; value: unknown } | { kind: 'capped'; text: string; pointer: string; originalTokens: number };
export function capSubagentResult(value: unknown, o: SubagentCapOptions): CappedSubagentResult {
  const limit = o.limit ?? 2000;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('invalid subagent token limit');
  const count = (s: string) => {
    const n = (o.countTokens ?? estimateResultTokens)(s);
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('invalid token count');
    return n;
  };
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text === undefined) throw new RangeError('result must be JSON serializable');
  const originalTokens = count(text);
  if (originalTokens <= limit) return { kind: 'complete', value };
  // Validate minimum marker space before writing anything through the port.
  if (count('[truncated; full result: ]') > limit) throw new RangeError('limit cannot fit a truncation marker');
  const pointer = o.port.store(value);
  if (typeof pointer !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,255}$/.test(pointer)) throw new RangeError('invalid full-result pointer');
  const marker = `\n[truncated; full result: ${pointer}]`;
  if (count(marker) > limit) throw new RangeError('limit cannot fit pointer and marker');
  // Prefer paragraph, line or word boundaries; fallback preserves whole Unicode code points.
  let prefix = '';
  for (const char of text) {
    if (count(prefix + char + marker) > limit) break;
    prefix += char;
  }
  const boundary = Math.max(prefix.lastIndexOf('\n\n'), prefix.lastIndexOf('\n'), prefix.lastIndexOf(' '));
  if (boundary > 0) prefix = prefix.slice(0, boundary);
  while (count(prefix + marker) > limit && prefix) prefix = Array.from(prefix).slice(0, -1).join('');
  return { kind: 'capped', text: prefix + marker, pointer, originalTokens };
}
