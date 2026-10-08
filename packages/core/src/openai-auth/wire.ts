import { OpenAIError } from './ports.ts';
const allowed = new Set(['model','input','instructions','tools','tool_choice','parallel_tool_calls','reasoning','text','store','stream','include','service_tier']);
const content = new Set(['input_text','output_text','input_image','refusal']);
/** Refuse unknown fields rather than silently weaken a caller's requested semantics. */
export function guardSiwc(request: Record<string, unknown>): Record<string, unknown> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new OpenAIError('siwc-unsupported');
  if (Object.keys(request).some(k => !allowed.has(k))) throw new OpenAIError('siwc-unsupported');
  if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.some(t => !t || typeof t !== 'object' || t.type !== 'function'))) throw new OpenAIError('siwc-unsupported');
  if (request.input !== undefined && typeof request.input !== 'string') {
    if (!Array.isArray(request.input)) throw new OpenAIError('siwc-unsupported');
    for (const item of request.input) {
      if (!item || typeof item !== 'object' || item.role === 'system') throw new OpenAIError('siwc-unsupported');
      if (item.type && !['message','function_call','function_call_output'].includes(item.type)) throw new OpenAIError('siwc-unsupported');
      if (item.content !== undefined && typeof item.content !== 'string' && (!Array.isArray(item.content) || item.content.some((p: { type?: string } | null) => !p || !content.has(p.type ?? '')))) throw new OpenAIError('siwc-unsupported');
    }
  }
  try { return { ...structuredClone(request), store: false, stream: true }; } catch { throw new OpenAIError('siwc-unsupported'); }
}
