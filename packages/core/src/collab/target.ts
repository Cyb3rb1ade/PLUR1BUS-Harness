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
/** Both current and legacy A2A registrations are remote; ACP external adapters retain their local-host contract. */
export function isA2aTarget(target: Pick<DelegationTarget, "kind" | "origin">): boolean {
  return target.origin === "a2a" || target.kind === "a2a";
}
export function targetRunner(targets: readonly DelegationTarget[]): AgentRunner {
  return { async run(input) {
    const matches = targets.filter(t => t.accepts(input.agentId));
    if (matches.length !== 1) throw new CollabError('invalid', 'delegation target missing or ambiguous');
    const target = matches[0]!;
    if (isA2aTarget(target) && input.handoff && (input.handoff.contract.kind === "handoff"
      || input.handoff.context.purpose === "independent-review" || input.handoff.context.readOnlyWorktree)) {
      throw new CollabError("unauthorized", "A2A targets cannot review local worktrees or receive card ownership");
    }
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
