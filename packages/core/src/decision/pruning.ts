import type { DecisionClient } from './client.ts';
import type { DecisionContext } from './types.ts';
import type { LayaDecisionPort, ToolPair } from '../session/pruning.ts';
/** Adapt the existing binary pruning port. F6 adds truncate; F2 never weakens the pruner's protection checks.
 * Raw tool pairs are local-only, even if cloud is allowed for ordinary task excerpts. */
export function decisionPruningPort(client: DecisionClient, scope: (pair: ToolPair, signal: AbortSignal) => DecisionContext): LayaDecisionPort {
  return async (batch, task, signal) => {
    const output = [];
    for (const pair of batch) {
      const context = { ...scope(pair, signal), signal, forceLocal: true };
      const result = await client.choice({ useCase: 'pruning', state: pair.text, question: 'Is this completed tool pair still needed for the current task? Keep when uncertain.', features: { task: task.slice(0, 1024) }, options: [{ id: 'keep', description: 'Still useful or uncertain' }, { id: 'drop', description: 'Obsolete and safely recoverable from the session store' }] }, context);
      output.push({ ref: pair.ref, relevant: !result.ok || result.value.id !== 'drop', reason: result.ok ? 'decision-accepted' : `decision-${result.reason}` });
    }
    return output;
  };
}
