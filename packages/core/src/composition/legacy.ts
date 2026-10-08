import type { StreamingAdapter } from '../../../providers/src/index.ts';
import type { ChatProvider } from '../session/provider.ts';
import { turnContext } from './context.ts';
/** Existing in-process test seam still traverses the router and budget; it receives the session request, never auth. */
export function legacyAdapter(provider: ChatProvider): StreamingAdapter {
  return { async *stream(_request, options) {
    const request = turnContext.getStore();
    if (!request) throw new Error('turn context missing');
    let text = '', usage: { inputTokens: number; outputTokens: number } | undefined;
    const calls: { id: string; name: string; argumentsRaw: string; arguments: Record<string, never> }[] = [];
    for await (const chunk of provider.stream({ ...request, signal: options?.signal ?? request.signal })) {
      if (chunk.type === 'delta') { text += chunk.text; yield { type: 'text_delta', text: chunk.text }; }
      else if (chunk.type === 'usage') usage = { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens };
      else if (chunk.type === 'tool.call') calls.push({ id: chunk.id, name: chunk.name, argumentsRaw: JSON.stringify(chunk.args ?? {}), arguments: chunk.args as Record<string, never> });
    }
    yield { type: 'done', result: { text, toolCalls: calls, finishReason: calls.length ? 'tool_calls' : 'stop', rawFinishReason: 'stop', ...(usage ? { usage } : {}), meta: {} } };
  } };
}
