// Synthetic SSE for all shipped chat wires. Fetch returns a Response in memory: no sockets, DNS or network.
export type Wire = 'chat_completions' | 'anthropic_messages' | 'codex_responses' | 'gemini';
export interface FixtureCall { name: string; args: unknown }
export interface FixtureReply { text?: string; call?: FixtureCall; status?: number; inputTokens?: number; cacheRead?: number; cacheWrite?: number }
export function wireFixture(wire: Wire, replies: readonly FixtureReply[]) {
  const bodies: Record<string, unknown>[] = [];
  let calls = 0;
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>; bodies.push(body);
    const reply = replies[Math.min(calls++, replies.length - 1)]!;
    if (reply.status) return new Response(JSON.stringify({ error: { message: 'synthetic failure', type: reply.status === 401 ? 'authentication_error' : 'rate_limit_error' } }), { status: reply.status, headers: { 'content-type': 'application/json' } });
    const input = reply.inputTokens ?? 100, read = reply.cacheRead ?? 0, write = reply.cacheWrite ?? 0;
    const text = reply.text ?? 'fixture done'; const call = reply.call;
    const raw = JSON.stringify(call?.args ?? {});
    const events: [string | null, unknown][] = [];
    if (wire === 'chat_completions') {
      events.push([null, { id: 'fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: call ? { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: call.name, arguments: raw } }] } : { content: text }, finish_reason: null }] }]);
      events.push([null, { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: input, completion_tokens: 10, total_tokens: input + 10, prompt_tokens_details: { cached_tokens: read } } }]);
    } else if (wire === 'anthropic_messages') {
      events.push(['message_start', { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: input - read - write, output_tokens: 0, cache_read_input_tokens: read, cache_creation_input_tokens: write } } }]);
      events.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: call ? { type: 'tool_use', id: 'c1', name: call.name, input: {} } : { type: 'text', text: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: call ? { type: 'input_json_delta', partial_json: raw } : { type: 'text_delta', text } }]);
      events.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
      events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } }]);
      events.push(['message_stop', { type: 'message_stop' }]);
    } else if (wire === 'codex_responses') {
      events.push(['response.created', { type: 'response.created', response: { id: 'fixture', object: 'response', model: body.model, status: 'in_progress', output: [] } }]);
      const item = call ? { type: 'function_call', id: 'fc1', call_id: 'c1', name: call.name, arguments: raw, status: 'completed' } : { type: 'message', id: 'msg1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] };
      events.push(['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: call ? { ...item, arguments: '', status: 'in_progress' } : { ...item, content: [], status: 'in_progress' } }]);
      if (call) events.push(['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc1', delta: raw }]);
      else { events.push(['response.content_part.added', { type: 'response.content_part.added', output_index: 0, item_id: 'msg1', content_index: 0, part: { type: 'output_text', text: '' } }]); events.push(['response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, item_id: 'msg1', content_index: 0, delta: text }]); }
      events.push(['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }]);
      events.push(['response.completed', { type: 'response.completed', response: { id: 'fixture', model: body.model, status: 'completed', output: [item], usage: { input_tokens: input, output_tokens: 10, total_tokens: input + 10, input_tokens_details: { cached_tokens: read } } } }]);
    } else {
      events.push([null, { candidates: [{ index: 0, content: { role: 'model', parts: call ? [{ functionCall: { name: call.name, args: call.args } }] : [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: input, candidatesTokenCount: 10, totalTokenCount: input + 10, cachedContentTokenCount: read } }]);
    }
    const sse = events.map(([event, data]) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`).join('') + (wire === 'chat_completions' ? 'data: [DONE]\n\n' : '');
    return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof globalThis.fetch;
  return { fetch, bodies, get calls() { return calls; } };
}
