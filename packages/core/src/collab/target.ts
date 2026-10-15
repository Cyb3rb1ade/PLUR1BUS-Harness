import type { AgentRunInput, AgentRunResult, AgentRunner } from './runner.ts';
import { handoffTicket, type HandoffAck } from './handoff.ts';
import { CollabError } from './errors.ts';

/** Single M5 target port. M6 ACP/A2A adapters implement this, never register another delegate_task. No target owns a PLUR1BUS memory store. */
export interface DelegationTarget {
  readonly kind: 'local' | 'external' | 'a2a';
  accepts(agentId: string): boolean;
  ack(input: AgentRunInput): Promise<HandoffAck>;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
export function targetRunner(targets: readonly DelegationTarget[]): AgentRunner {
  return { async run(input) {
    const matches = targets.filter(t => t.accepts(input.agentId));
    if (matches.length !== 1) throw new CollabError('invalid', 'delegation target missing or ambiguous');
    const target = matches[0]!;
    if (!input.handoff) return target.run(input);
    const to = input.handoff.contract.to;
    if ('agent' in to && to.agent !== input.agentId) throw new CollabError('unauthorized', 'handoff target mismatch');
    const ticket = handoffTicket(input.handoff.contract, input.handoff.context);
    if (input.handoff.contract.kind !== 'consult') ticket.ack(await target.ack(input));
    input.signal.throwIfAborted();
    return ticket.start(() => target.run(input));
  } };
}
