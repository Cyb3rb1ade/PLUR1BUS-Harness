import type { AgentRunInput, AgentRunResult, AgentRunner } from './runner.ts';
import { handoffTicket, type HandoffAck } from './handoff.ts';
import { CollabError } from './errors.ts';

/** Single M5 target port. M6 ACP/A2A adapters implement this, never register another delegate_task. No target owns a PLUR1BUS memory store. */
export interface DelegationTarget {
  readonly origin?: 'a2a';
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
    const scoped = { ...input, onProgress: (progress: AgentRunResult) => input.onProgress?.({ ...progress, targetKind: target.kind }) };
    const run = async () => { const out = await target.run(scoped); return { ...out, ...(input.handoff || input.sessionId ? { targetKind: target.kind } : {}), ...(target.origin ? { origin: target.origin } : {}) }; };
    if (!input.handoff) return run();
    const to = input.handoff.contract.to;
    if ('agent' in to && to.agent !== input.agentId) throw new CollabError('unauthorized', 'handoff target mismatch');
    const ticket = handoffTicket(input.handoff.contract, input.handoff.context);
    if (input.handoff.contract.kind !== 'consult') { const ack = await target.ack(scoped); input.onTranscript?.({ kind: 'ack', data: ack }); ticket.ack(ack); }
    input.signal.throwIfAborted();
    return ticket.start(() => { input.handoff!.context.onAccepted?.(); return run(); });
  } };
}
