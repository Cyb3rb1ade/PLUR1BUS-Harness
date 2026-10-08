import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { capSubagentResult } from '../budget/index.ts';
import type { ChatProvider } from '../session/provider.ts';
import type { AgentRunner } from '../collab/runner.ts';
import type { AgentScopePort } from '../collab/ports.ts';
import { CollabError } from '../collab/errors.ts';

/** The authenticated collab caller and AgentScope travel to the same provider pipeline; full returns stay private. */
export function composedAgentRunner(provider: ChatProvider, scope: AgentScopePort, home: string): AgentRunner {
  return { async run(input) {
    const held = scope.current();
    if (!held || held.agentId !== input.agentId || !input.principal) throw new CollabError('no-scope', 'authenticated caller and target AgentScope required');
    let text = '', inputTokens = 0, outputTokens = 0;
    for await (const chunk of provider.stream({ principal: input.principal.userId, sessionId: `collab:${held.projectId}`, turnId: randomUUID(), agentId: input.agentId, projectId: held.projectId, toolView: held.toolView, headlessJobId: `collab:${held.projectId}`, summaries: [], memory: '', messages: [{ role: 'user', text: `${input.question}\n\n${input.context}` }], signal: input.signal })) {
      input.signal.throwIfAborted();
      if (chunk.type === 'delta') text += chunk.text;
      else if (chunk.type === 'usage') { inputTokens = chunk.inputTokens; outputTokens = chunk.outputTokens; }
    }
    const capped = capSubagentResult(text, { limit: 2000, port: { store(value) {
      const dir = join(home, 'state', 'subagent-results'); mkdirSync(dir, { recursive: true, mode: 0o700 });
      const id = randomUUID(); writeFileSync(join(dir, `${id}.json`), JSON.stringify({ principal: input.principal!.userId, project: held.projectId, value }), { flag: 'wx', mode: 0o600 }); return `subagent-result:${id}`;
    } } });
    return { text: capped.kind === 'capped' ? capped.text : String(capped.value), inputTokens, outputTokens };
  } };
}
